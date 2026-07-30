import type { RepoConfig } from "../config/types.ts";
import { GitHub, type UpstreamSnapshot } from "../github/client.ts";
import { type ComposedBranch, type ConflictResolver, composeBranch } from "./compose.ts";
import { publishContainer } from "./container.ts";
import { FORK_REMOTE, UPSTREAM_REMOTE, Workspace } from "./workspace.ts";

export interface RunOptions {
	token: string;
	/** Repository running the workflow, for the container source label. */
	sourceRepository: string;
	dryRun: boolean;
	resolver?: ConflictResolver;
}

export interface BranchReport {
	branch: string;
	status: "unchanged" | "updated" | "failed";
	detail: string;
	composed?: ComposedBranch;
	image?: string;
}

export interface RepoReport {
	repository: string;
	branches: BranchReport[];
	failed: boolean;
}

/**
 * Run one managed repository.
 *
 * Branches are independent: one failing must not stop the others, since a
 * prerelease branch breaking is no reason to withhold a good stable build.
 */
export async function runRepository(config: RepoConfig, options: RunOptions): Promise<RepoReport> {
	const github = new GitHub(options.token);
	const [snapshot, committer] = await Promise.all([
		github.snapshot(config.upstream.repository, config.fork),
		github.viewer(),
	]);

	const workspace = await Workspace.create({
		forkRepository: config.fork,
		upstreamRepository: config.upstream.repository,
		token: options.token,
		committer,
	});

	const report: RepoReport = { repository: config.fork, branches: [], failed: false };

	try {
		await workspace.fetch(UPSTREAM_REMOTE, [
			`+refs/heads/${config.upstream.branch}:refs/remotes/upstream/${config.upstream.branch}`,
		]);

		const contributionRefs = [
			...new Set(config.branches.flatMap((rule) => rule.contributions)),
		].map((branch) => `+refs/heads/${branch}:refs/remotes/${FORK_REMOTE}/${branch}`);
		await workspace.fetch(FORK_REMOTE, contributionRefs);

		// Bases referenced by open pull requests, so a contribution's delta is
		// measured from the branch its pull request targets.
		const baseRefs = [...new Set(snapshot.openPullRequests.map((pull) => pull.baseRef))].map(
			(ref) => `+refs/heads/${ref}:refs/remotes/upstream/${ref}`,
		);
		await workspace.fetch(UPSTREAM_REMOTE, baseRefs);

		for (const rule of config.branches) {
			report.branches.push(await runBranch(rule, config, workspace, snapshot, github, options));
		}

		if (report.branches.some((branch) => branch.status === "failed")) report.failed = true;
	} finally {
		await workspace.dispose();
	}

	return report;
}

async function runBranch(
	rule: RepoConfig["branches"][number],
	config: RepoConfig,
	workspace: Workspace,
	snapshot: UpstreamSnapshot,
	github: GitHub,
	options: RunOptions,
): Promise<BranchReport> {
	try {
		const composed = await composeBranch(
			rule,
			config,
			workspace.git,
			snapshot,
			github,
			options.resolver,
		);

		if (!composed.changed) {
			return {
				branch: rule.name,
				status: "unchanged",
				detail: `already at ${composed.source.ref} (${composed.commit.slice(0, 8)})`,
				composed,
			};
		}

		// Built and smoke-tested before the branch moves, so a branch never points
		// at a tree that failed to produce a working image.
		let image: string | undefined;
		if (rule.container) {
			const published = await publishContainer(composed, {
				container: rule.container,
				worktree: workspace.git.cwd,
				sourceRepository: options.sourceRepository,
				dryRun: options.dryRun,
			});
			image = published.immutable;
		}

		if (!options.dryRun) {
			await workspace.git.pushWithLease(FORK_REMOTE, rule.name, composed.commit, composed.previous);
		}

		const summary = [
			`${composed.source.ref} + ${composed.applied.length} contribution(s)`,
			...composed.skipped.map((skip) => `skipped ${skip.branch}: ${skip.reason}`),
		].join("; ");

		return { branch: rule.name, status: "updated", detail: summary, composed, image };
	} catch (error) {
		return { branch: rule.name, status: "failed", detail: (error as Error).message };
	}
}
