import { contributionIdentity, contributionSpec, type ContributionSpec } from "../config/types.ts";
import type { Git } from "../git/git.ts";
import type { GitHub, PullRequest, UpstreamSnapshot } from "../github/client.ts";
import { UPSTREAM_REMOTE } from "./workspace.ts";

/** A contribution's delta, ready to apply onto a tracked source. */
export interface ResolvedContribution {
	branch: string;
	base: string;
	head: string;
	pullRequest: PullRequest | undefined;
}

export type ContributionOutcome =
	| { status: "apply"; contribution: ResolvedContribution }
	| { status: "skip"; branch: string; reason: string };

export class PullRequestHeadMismatchError extends Error {
	constructor(readonly upstreamRepository: string, readonly number: number, readonly expected: string, readonly actual: string) {
		super(`Pull request #${number} in ${upstreamRepository} changed while resolving: GitHub reported ${expected}, but refs/pull/${number}/head resolved to ${actual}`);
		this.name = "PullRequestHeadMismatchError";
	}
}

/** Resolve every input through the same fetch, shipped-check and delta pipeline. */
export async function resolveContribution(
	input: ContributionSpec,
	git: Git,
	forkRemote: string,
	upstreamRepository: string | undefined,
	forkRepository: string,
	upstreamBranch: string,
	sourceCommit: string,
	snapshot: UpstreamSnapshot,
	github: GitHub,
): Promise<ContributionOutcome> {
	const spec = contributionSpec(input, upstreamRepository !== undefined);
	const { branch, remote, ref, pullRequest } = await resolveInput(
		spec, git, forkRemote, upstreamRepository, forkRepository, snapshot, github,
	);
	const merge = pullRequest?.merged ? pullRequest.mergeCommitSha : undefined;
	if (spec.cleanup === "when-merged" && merge && await git.isAncestor(merge, sourceCommit)) {
		return {
			status: "skip",
			branch,
			reason: `merged upstream as ${merge.slice(0, 8)} and present in the tracked source`,
		};
	}

	const localRef = `refs/forkit/contributions/${Buffer.from(branch).toString("hex")}`;
	await git.fetch(remote, [`+${ref}:${localRef}`]);
	const head = await git.revParse(localRef);
	if (upstreamRepository && pullRequest && head !== pullRequest.headSha) {
		throw new PullRequestHeadMismatchError(upstreamRepository, pullRequest.number, pullRequest.headSha, head);
	}

	if (spec.base) {
		if (!(await git.isAncestor(spec.base, head))) {
			throw new Error(`Contribution "${branch}" does not descend from its declared base ${spec.base}`);
		}
		return { status: "apply", contribution: { branch, base: spec.base, head, pullRequest } };
	}

	// Preserve the delta of an unshipped merged PR, rather than comparing its
	// head with an upstream branch that already contains it.
	const baseBranch = pullRequest?.baseRef ?? upstreamBranch;
	const baseRef = merge ? `${merge}^1` : `refs/remotes/${UPSTREAM_REMOTE}/${baseBranch}`;
	if (!(await git.exists(baseRef))) {
		await git.fetch(UPSTREAM_REMOTE, [merge ?? `+refs/heads/${baseBranch}:${baseRef}`]);
	}
	const base = await git.mergeBase(baseRef, head);
	return { status: "apply", contribution: { branch, base, head, pullRequest } };
}

/** Configuration-specific lookup stops here; the engine consumes Git refs. */
async function resolveInput(
	spec: ContributionSpec & { cleanup: "manual" | "when-merged" },
	git: Git,
	forkRemote: string,
	upstreamRepository: string | undefined,
	forkRepository: string,
	snapshot: UpstreamSnapshot,
	github: GitHub,
): Promise<{ branch: string; remote: string; ref: string; pullRequest: PullRequest | undefined }> {
	let pullRequest: PullRequest | undefined;
	if (spec.type === "pr") {
		if (!upstreamRepository) throw new Error("PR contributions require a GitHub upstream");
		pullRequest = await github.getPullRequest(upstreamRepository, spec.number);
	} else if (upstreamRepository && spec.cleanup === "when-merged") {
		pullRequest = snapshot.openPullRequests.find(
			(pull) => pull.headRepo === forkRepository && pull.headRef === spec.name,
		) ?? await github.findPullRequestForBranch(upstreamRepository, forkRepository, spec.name);
		if (pullRequest?.merged) {
			// A branch can be reused after its old PR merges. Do not substitute
			// the old PR head or remove new work from the contribution list.
			const head = await git.remoteTip(forkRemote, spec.name);
			if (head && head !== pullRequest.headSha) pullRequest = undefined;
		}
	}
	const branch = contributionIdentity(spec, upstreamRepository ?? forkRepository);
	return {
		branch,
		remote: pullRequest ? UPSTREAM_REMOTE : forkRemote,
		ref: pullRequest ? `refs/pull/${pullRequest.number}/head` : `refs/heads/${branch}`,
		pullRequest,
	};
}
