import type { Git } from "../git/git.ts";
import type { GitHub, PullRequest, UpstreamSnapshot } from "../github/client.ts";
import { contributionSpec, type Contribution } from "../config/types.ts";

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
	input: Contribution,
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
	const { branch } = spec;
	const ref = `${forkRemote}/${branch}`;
	const head = (await git.exists(ref)) ? await git.revParse(ref) : undefined;

	// The open set is already in the snapshot; only fall back to a query for
	// contributions that are listed but no longer open.
	const pullRequest = upstreamRepository && spec.cleanup === "when-merged"
		? snapshot.openPullRequests.find((pull) => pull.headRef === branch) ??
			(await github.findPullRequestForBranch(upstreamRepository, forkRepository, branch))
		: undefined;

	// A reused branch may carry new work beyond the PR that previously merged.
	if (pullRequest?.merged && pullRequest.mergeCommitSha && (!head || head === pullRequest.headSha)) {
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
	if (!head) throw new MissingContributionError(branch, forkRepository);
	if (spec.base) {
		if (!(await git.isAncestor(spec.base, head))) {
			throw new Error(`Contribution "${branch}" does not descend from its declared base ${spec.base}`);
		}
		return { status: "apply", contribution: { branch, base: spec.base, head, pullRequest } };
	}

	// A pull request records the branch it was written against; without one the
	// development branch is the only sensible reference point.
	const baseRef = pullRequest ? `upstream/${pullRequest.baseRef}` : `upstream/${upstreamBranch}`;
	if (!(await git.exists(baseRef))) {
		await git.fetch("upstream", [`+refs/heads/${pullRequest?.baseRef ?? upstreamBranch}:refs/remotes/${baseRef}`]);
	}
	const base = await git.mergeBase(baseRef, head);

	return { status: "apply", contribution: { branch, base, head, pullRequest } };
}
