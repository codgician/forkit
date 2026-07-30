import type { RepoConfig } from "../config/types.ts";
import { checkResolution } from "../git/gates.ts";
import type { Git } from "../git/git.ts";
import type { PullRequest, UpstreamSnapshot } from "../github/client.ts";
import type { ConflictResolver } from "./compose.ts";
import { FORK_REMOTE, UPSTREAM_REMOTE } from "./workspace.ts";

export interface MaintenanceResult {
	branch: string;
	pullRequest: number;
	status: "up-to-date" | "merged" | "resolved" | "failed";
	detail: string;
	/** Commit to push; absent when nothing changed or the attempt failed. */
	commit?: string;
	/** Tip observed before the merge, for lease protection. */
	previous?: string;
}

/**
 * Merge each open pull request's base branch into its head branch.
 *
 * Merge rather than rebase: these branches are attached to open upstream pull
 * requests, so rewriting their history would force-push over commits a
 * maintainer may already be reviewing.
 */
export async function maintainPullRequestBranches(
	config: RepoConfig,
	git: Git,
	snapshot: UpstreamSnapshot,
	resolver: ConflictResolver | undefined,
): Promise<MaintenanceResult[]> {
	const results: MaintenanceResult[] = [];

	for (const pull of snapshot.openPullRequests) {
		results.push(await maintainOne(pull, config, git, resolver));
	}

	return results;
}

async function maintainOne(
	pull: PullRequest,
	config: RepoConfig,
	git: Git,
	resolver: ConflictResolver | undefined,
): Promise<MaintenanceResult> {
	const base = { branch: pull.headRef, pullRequest: pull.number };

	try {
		await git.fetch(UPSTREAM_REMOTE, [`+refs/heads/${pull.baseRef}:refs/forkit/pr-base`]);
		await git.fetch(FORK_REMOTE, [`+refs/heads/${pull.headRef}:refs/forkit/pr-head`]);

		const baseCommit = await git.revParse("refs/forkit/pr-base");
		const headCommit = await git.revParse("refs/forkit/pr-head");

		if (headCommit !== pull.headSha) {
			return {
				...base,
				status: "failed",
				detail: `branch moved during the run (${pull.headSha.slice(0, 8)} -> ${headCommit.slice(0, 8)})`,
			};
		}

		if (await git.isAncestor(baseCommit, headCommit)) {
			return { ...base, status: "up-to-date", detail: `already contains ${pull.baseRef}` };
		}

		await git.checkoutDetached(headCommit);
		const conflict = await git.merge(
			baseCommit,
			`Merge ${config.upstream.repository} ${pull.baseRef} into ${pull.headRef}`,
		);

		if (!conflict) {
			return {
				...base,
				status: "merged",
				detail: `merged ${pull.baseRef} cleanly`,
				commit: await git.revParse("HEAD"),
				previous: headCommit,
			};
		}

		if (config.pullRequestMaintenance.onConflict === "fail" || !resolver) {
			await git.git(["merge", "--abort"], { check: false });
			return { ...base, status: "failed", detail: `conflicts in: ${conflict.paths.join(", ")}` };
		}

		const outcome = await resolver.resolve({
			git,
			conflict,
			description: `pull request #${pull.number} ("${pull.headRef}") merging its base ${pull.baseRef}`,
			baseline: headCommit,
			upstreamCommits: await git.logSubjects(`${headCommit}..${baseCommit}`, 40).catch(() => []),
			pullRequest: { number: pull.number, title: pull.title, body: pull.body },
		});

		if (outcome.status === "failed") {
			await git.git(["merge", "--abort"], { check: false });
			return { ...base, status: "failed", detail: `resolution failed: ${outcome.reason}` };
		}

		const failures = await checkResolution(git, conflict.paths, headCommit);
		if (failures.length > 0) {
			await git.git(["merge", "--abort"], { check: false });
			return {
				...base,
				status: "failed",
				detail: `resolution failed its checks: ${failures.map((f) => f.gate).join(", ")}`,
			};
		}

		const commit = await git.commitAll(
			[
				`Merge ${config.upstream.repository} ${pull.baseRef} into ${pull.headRef}`,
				"",
				"Conflicted; resolved as:",
				outcome.summary,
				"",
				`Forkit-Merged-Base: ${baseCommit}`,
				`Forkit-Conflicted: ${conflict.paths.join(", ")}`,
				"Forkit-Resolved-By: ai",
			].join("\n"),
		);

		return {
			...base,
			status: "resolved",
			detail: `resolved conflicts in: ${conflict.paths.join(", ")}`,
			commit,
			previous: headCommit,
		};
	} catch (error) {
		return { ...base, status: "failed", detail: (error as Error).message };
	}
}
