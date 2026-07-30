import type { Git } from "../git/git.ts";
import type { GitHub, PullRequest, UpstreamSnapshot } from "../github/client.ts";

/** A contribution's delta, ready to apply onto a tracked source. */
export interface ResolvedContribution {
	branch: string;
	/** Commit the contribution was written against. */
	base: string;
	/** Tip of the contribution branch. */
	head: string;
	pullRequest: PullRequest | undefined;
}

export type ContributionOutcome =
	| { status: "apply"; contribution: ResolvedContribution }
	| { status: "skip"; branch: string; reason: string };

export class MissingContributionError extends Error {
	constructor(readonly branch: string, forkRepository: string) {
		super(`Contribution branch "${branch}" does not exist in ${forkRepository}`);
		this.name = "MissingContributionError";
	}
}

/**
 * Decide whether a contribution still applies to `sourceCommit`, and if so from
 * which base.
 *
 * A contribution is dropped only once upstream has actually shipped it: the
 * pull request merged *and* the tracked release contains that merge. Dropping
 * at merge time instead would remove the change for however many weeks pass
 * before the next release, which is exactly the window this exists to cover.
 */
export async function resolveContribution(
	branch: string,
	git: Git,
	forkRemote: string,
	upstreamRepository: string,
	forkRepository: string,
	upstreamBranch: string,
	sourceCommit: string,
	snapshot: UpstreamSnapshot,
	github: GitHub,
): Promise<ContributionOutcome> {
	const ref = `${forkRemote}/${branch}`;
	if (!(await git.exists(ref))) throw new MissingContributionError(branch, forkRepository);

	const head = await git.revParse(ref);

	// The open set is already in the snapshot; only fall back to a query for
	// contributions that are listed but no longer open.
	const pullRequest =
		snapshot.openPullRequests.find((pull) => pull.headRef === branch) ??
		(await github.findPullRequestForBranch(upstreamRepository, forkRepository, branch));

	if (pullRequest?.merged && pullRequest.mergeCommitSha) {
		const shipped = await git
			.isAncestor(pullRequest.mergeCommitSha, sourceCommit)
			.catch(() => false);
		if (shipped) {
			return {
				status: "skip",
				branch,
				reason: `merged upstream as ${pullRequest.mergeCommitSha.slice(0, 8)} and present in the tracked source`,
			};
		}
	}

	// A pull request records the branch it was written against; without one the
	// development branch is the only sensible reference point.
	const baseRef = pullRequest ? `upstream/${pullRequest.baseRef}` : `upstream/${upstreamBranch}`;
	const base = await git.mergeBase(baseRef, head);

	return { status: "apply", contribution: { branch, base, head, pullRequest } };
}
