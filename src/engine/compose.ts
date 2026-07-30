import type { BranchRule, RepoConfig } from "../config/types.ts";
import { checkResolution } from "../git/gates.ts";
import type { ConflictState, Git } from "../git/git.ts";
import type { GitHub, UpstreamSnapshot } from "../github/client.ts";
import { type ContributionOutcome, resolveContribution } from "./contribution.ts";
import { type ResolvedSource, resolveSource } from "./source.ts";
import { FORK_REMOTE, UPSTREAM_REMOTE } from "./workspace.ts";

/** Resolves a conflict in place, or reports that it could not. */
export interface ConflictResolver {
	resolve(context: ResolverContext): Promise<ResolverOutcome>;
}

export interface ResolverContext {
	git: Git;
	conflict: ConflictState;
	/** What is being combined, for the resolver's prompt. */
	description: string;
	/** Commit the resolution is measured against for the gates. */
	baseline: string;
	upstreamCommits: string[];
	pullRequest: { number: number; title: string; body: string } | undefined;
}

export type ResolverOutcome =
	| { status: "resolved"; summary: string }
	| { status: "failed"; reason: string };

export interface ComposedBranch {
	branch: string;
	source: ResolvedSource;
	sourceCommit: string;
	/** Commit forkit produced; equals sourceCommit for an unmodified mirror. */
	commit: string;
	applied: string[];
	skipped: { branch: string; reason: string }[];
	/** Absent when the branch already matched. */
	previous: string | undefined;
	changed: boolean;
}

export class ComposeError extends Error {
	constructor(message: string, readonly branch: string) {
		super(message);
		this.name = "ComposeError";
	}
}

/**
 * Build a branch's target tree.
 *
 * Composition is all-or-nothing: a contribution that cannot be applied fails
 * the branch rather than producing a partial patch set, because publishing an
 * image that silently lacks a patch is worse than publishing nothing.
 */
export async function composeBranch(
	rule: BranchRule,
	config: RepoConfig,
	git: Git,
	snapshot: UpstreamSnapshot,
	github: GitHub,
	resolver: ConflictResolver | undefined,
): Promise<ComposedBranch> {
	const source = resolveSource(rule.track, config.upstream.repository, snapshot);

	await git.fetch(UPSTREAM_REMOTE, [`+${source.fetchSpec}:refs/forkit/source`]);
	const sourceCommit = await git.revParse("refs/forkit/source");

	const previous = await git.remoteTip(FORK_REMOTE, rule.name);

	if (rule.track.kind === "branch") {
		// A mirror is the upstream commit itself; nothing is composed on top.
		return {
			branch: rule.name,
			source,
			sourceCommit,
			commit: sourceCommit,
			applied: [],
			skipped: [],
			previous,
			changed: previous !== sourceCommit,
		};
	}

	await git.checkoutDetached(sourceCommit);

	const applied: string[] = [];
	const skipped: ComposedBranch["skipped"] = [];

	for (const branch of rule.contributions) {
		const outcome = await resolveContribution(
			branch,
			git,
			FORK_REMOTE,
			config.upstream.repository,
			config.fork,
			config.upstream.branch,
			sourceCommit,
			snapshot,
			github,
		);

		if (outcome.status === "skip") {
			skipped.push({ branch: outcome.branch, reason: outcome.reason });
			continue;
		}

		await applyContribution(outcome, rule, config, git, source, resolver);
		applied.push(branch);
	}

	const commit = await git.revParse("HEAD");
	return {
		branch: rule.name,
		source,
		sourceCommit,
		commit,
		applied,
		skipped,
		previous,
		changed: previous !== commit,
	};
}

async function applyContribution(
	outcome: Extract<ContributionOutcome, { status: "apply" }>,
	rule: BranchRule,
	config: RepoConfig,
	git: Git,
	source: ResolvedSource,
	resolver: ConflictResolver | undefined,
): Promise<void> {
	const { branch, base, head, pullRequest } = outcome.contribution;
	const baseline = await git.revParse("HEAD");

	// Forkit pushes with an App token holding workflows:write, which it needs
	// only to replay upstream's own CI as a branch advances. A contribution that
	// changed CI would quietly borrow that permission, so it is refused here.
	const touched = await git.changedPathsBetween(base, head);
	const ci = touched.filter((path) => path.startsWith(".github/workflows/"));
	if (ci.length > 0) {
		throw new ComposeError(
			`Contribution "${branch}" changes CI definitions, which forkit does not push: ${ci.join(", ")}`,
			rule.name,
		);
	}

	const conflict = await git.applyDelta(base, head);

	let resolution: string | undefined;
	if (conflict) {
		if (rule.onConflict === "fail" || !resolver) {
			throw new ComposeError(
				`Applying "${branch}" to ${source.ref} conflicts in: ${conflict.paths.join(", ")}`,
				rule.name,
			);
		}

		resolution = await resolveConflict(resolver, {
			git,
			conflict,
			description: `contribution "${branch}" applied to ${config.upstream.repository} ${source.ref}`,
			baseline,
			upstreamCommits: await git.logSubjects(`${base}..${source.ref}`, 40).catch(() => []),
			pullRequest: pullRequest
				? { number: pullRequest.number, title: pullRequest.title, body: pullRequest.body }
				: undefined,
		}, rule.name, branch);
	}

	if (await git.isClean()) {
		throw new ComposeError(`Applying "${branch}" produced no change`, rule.name);
	}

	await git.commitAll(
		contributionMessage({ branch, base, head, pullRequest, source, resolution }),
	);
}

async function resolveConflict(
	resolver: ConflictResolver,
	context: ResolverContext,
	branchName: string,
	contribution: string,
): Promise<string> {
	const outcome = await resolver.resolve(context);
	if (outcome.status === "failed") {
		throw new ComposeError(`Resolving "${contribution}" failed: ${outcome.reason}`, branchName);
	}

	const failures = await checkResolution(context.git, context.conflict.paths, context.baseline);
	if (failures.length > 0) {
		throw new ComposeError(
			`Resolution of "${contribution}" failed its checks:\n${failures
				.map((failure) => `  ${failure.gate}: ${failure.detail}`)
				.join("\n")}`,
			branchName,
		);
	}

	return outcome.summary;
}

/**
 * The commit message is the durable record.
 *
 * Trajectory artifacts expire and workflow runs are deletable, so anything a
 * future reader needs while bisecting has to be here. Every field is an
 * observed fact; the resolver's own summary is quoted, never trusted as truth.
 */
function contributionMessage(input: {
	branch: string;
	base: string;
	head: string;
	pullRequest: { number: number; title: string } | undefined;
	source: ResolvedSource;
	resolution: string | undefined;
}): string {
	const title = input.pullRequest?.title ?? input.branch;
	const lines = [`forkit: ${title}`, ""];

	if (input.resolution) {
		lines.push(`Conflicted with ${input.source.ref}; resolved as:`, input.resolution, "");
	}

	lines.push(
		`Forkit-Contribution: ${input.branch}`,
		`Forkit-Source-Base: ${input.base}`,
		`Forkit-Source-Head: ${input.head}`,
		`Forkit-Applied-To: ${input.source.ref}`,
	);
	if (input.pullRequest) lines.push(`Forkit-Upstream-PR: #${input.pullRequest.number}`);
	if (input.resolution) lines.push("Forkit-Resolved-By: ai");

	return lines.join("\n");
}
