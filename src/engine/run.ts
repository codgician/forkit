import type { RepoConfig } from "../config/types.ts";
import { GitHub } from "../github/client.ts";
import { type ComposedBranch, type ConflictResolver, composeBranch } from "./compose.ts";
import { publishContainer } from "./container.ts";
import { maintainPullRequestBranches, type MaintenanceResult } from "./maintain.ts";
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
	maintenance: MaintenanceResult[];
	branches: BranchReport[];
	failed: boolean;
}

/**
 * Run one managed repository.
 *
 * Pull request branches are maintained first so that a contribution composed
 * afterwards picks up the freshly merged head rather than last run's.
 */
export async function runRepository(config: RepoConfig, options: RunOptions): Promise<RepoReport> {
	const github = new GitHub(options.token);
	const snapshot = await github.snapshot(config.upstream.repository, config.fork);

	const workspace = await Workspace.create({
		forkRepository: config.fork,
		upstreamRepository: config.upstream.repository,
		token: options.token,
	});

	const report: RepoReport = {
		repository: config.fork,
		maintenance: [],
		branches: [],
		failed: false,
	};

	try {
		const { git } = workspace;

		await workspace.fetch(UPSTREAM_REMOTE, [
			`+refs/heads/${config.upstream.branch}:refs/remotes/upstream/${config.upstream.branch}`,
		]);

		if (config.maintainPullRequestBranches) {
			report.maintenance = await maintainPullRequestBranches(config, git, snapshot, options.resolver);

			for (const result of report.maintenance) {
				if (!result.commit) continue;
				if (options.dryRun) continue;
				// Lease-protected against the tip observed before merging.
				await git.pushWithLease(FORK_REMOTE, result.branch, result.commit, result.previous);
			}
			if (report.maintenance.some((result) => result.status === "failed")) report.failed = true;
		}

		const contributionRefs = [
			...new Set(config.branches.flatMap((rule) => rule.contributions)),
		].map((branch) => `+refs/heads/${branch}:refs/remotes/${FORK_REMOTE}/${branch}`);
		await workspace.fetch(FORK_REMOTE, contributionRefs);

		// Bases referenced by open pull requests, for contribution merge-bases.
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
	snapshot: Awaited<ReturnType<GitHub["snapshot"]>>,
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

		let image: string | undefined;
		if (rule.image) {
			const published = await publishContainer(composed, {
				image: rule.image,
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
