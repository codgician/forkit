import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContributionSpec } from "../src/config/types.ts";
import {
	PullRequestHeadMismatchError,
	resolveContribution,
} from "../src/engine/contribution.ts";
import { Git } from "../src/git/git.ts";
import { type GitHub, GitHubError, type PullRequest, type UpstreamSnapshot } from "../src/github/client.ts";
import { composeBranch } from "../src/engine/compose.ts";
import type { BranchRule, RepoConfig } from "../src/config/types.ts";

const UPSTREAM_REPOSITORY = "upstream/project";
const FORK_REPOSITORY = "fork/project";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function newRepo(prefix: string): Promise<Git> {
	const dir = await mkdtemp(join(tmpdir(), `forkit-contribution-${prefix}-`));
	directories.push(dir);
	const git = new Git(dir);
	await git.git(["init", "--quiet", "--initial-branch=main"]);
	await git.git(["config", "user.name", "forkit-test"]);
	await git.git(["config", "user.email", "forkit-test@example.invalid"]);
	await git.git(["config", "commit.gpgsign", "false"]);
	return git;
}

async function newBareRepo(prefix: string): Promise<Git> {
	const dir = await mkdtemp(join(tmpdir(), `forkit-contribution-${prefix}-`));
	directories.push(dir);
	const git = new Git(dir);
	await git.git(["init", "--quiet", "--bare", "--initial-branch=main"]);
	return git;
}

async function commitFile(git: Git, path: string, contents: string, message: string): Promise<string> {
	await Bun.write(join(git.cwd, path), contents);
	await git.git(["add", path]);
	await git.git(["commit", "--quiet", "--no-verify", "-m", message]);
	return git.revParse("HEAD");
}

async function pushRef(git: Git, remote: string, commit: string, ref: string): Promise<void> {
	await git.git(["push", "--quiet", remote, `${commit}:${ref}`]);
}

function snapshot(openPullRequests: PullRequest[] = []): UpstreamSnapshot {
	return { releases: [], tags: [], openPullRequests };
}

function pullRequest(
	input: Partial<PullRequest> & Pick<PullRequest, "number" | "headSha">,
): PullRequest {
	const { number, headSha, ...overrides } = input;
	return {
		number,
		title: "Test contribution",
		body: "",
		draft: false,
		state: "open",
		merged: false,
		mergeCommitSha: undefined,
		baseRef: "main",
		headRepo: "outside/contributor",
		headRef: "topic",
		headSha,
		...overrides,
	};
}

function github(responses: {
	pullRequests?: Record<string, PullRequest>;
	branchPullRequest?: PullRequest;
} = {}): GitHub {
	return {
		getPullRequest: async (_upstreamRepository: string, number: number) => {
			const pull = responses.pullRequests?.[String(number)];
			if (!pull) throw new Error(`Missing test pull request #${number}`);
			return pull;
		},
		findPullRequestForBranch: async () => responses.branchPullRequest,
	} as unknown as GitHub;
}

async function resolve(
	git: Git,
	contribution: ContributionSpec,
	sourceCommit: string,
	upstreamSnapshot: UpstreamSnapshot,
	client: GitHub,
) {
	return resolveContribution(
		contribution,
		git,
		"fork",
		UPSTREAM_REPOSITORY,
		FORK_REPOSITORY,
		"main",
		sourceCommit,
		upstreamSnapshot,
		client,
	);
}

describe("resolveContribution", () => {
	test("fetches an unpublished branch without requiring contribution prefetch", async () => {
		const upstream = await newBareRepo("plain-upstream");
		const fork = await newBareRepo("plain-fork");
		const seed = await newRepo("plain-seed");
		await seed.addRemote("upstream", upstream.cwd);
		await seed.addRemote("fork", fork.cwd);
		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.pushFastForward("upstream", "main", base);
		const head = await commitFile(seed, "private-fix.txt", "unpublished fix\n", "private fix");
		await seed.pushFastForward("fork", "topic", head);

		const checkout = await newRepo("plain-checkout");
		await checkout.addRemote("upstream", upstream.cwd);
		await checkout.addRemote("fork", fork.cwd);
		await checkout.fetch("upstream", [base]);
		const outcome = await resolve(checkout, { type: "branch", name: "topic" }, base, snapshot(), github());
		if (outcome.status !== "apply") throw new Error("expected the unpublished branch to apply");
		await checkout.checkoutDetached(base);
		expect(await checkout.applyDelta(outcome.contribution.base, outcome.contribution.head)).toBeUndefined();
		expect(await Bun.file(join(checkout.cwd, "private-fix.txt")).text()).toBe("unpublished fix\n");
	});

	test("fetches a third-party PR from its upstream ref and uses its actual nondefault base", async () => {
		const upstream = await newBareRepo("upstream");
		const fork = await newBareRepo("fork");
		const seed = await newRepo("seed");
		await seed.addRemote("upstream", upstream.cwd);
		await seed.addRemote("fork", fork.cwd);

		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.pushFastForward("upstream", "main", base);
		await seed.git(["checkout", "--quiet", "-b", "release", base]);
		const releaseBase = await commitFile(seed, "release.txt", "release base\n", "release base");
		await seed.pushFastForward("upstream", "release", releaseBase);
		await seed.git(["checkout", "--quiet", "-b", "topic", releaseBase]);
		const prHead = await commitFile(seed, "upstream-fix.txt", "third party\n", "third-party fix");
		await pushRef(seed, "upstream", prHead, "refs/pull/42/head");

		await seed.git(["checkout", "--quiet", "-B", "main", base]);
		const mainHead = await commitFile(seed, "main.txt", "main only\n", "main advance");
		await seed.pushFastForward("upstream", "main", mainHead);
		await seed.git(["checkout", "--quiet", "-B", "topic", mainHead]);
		const forkHead = await commitFile(seed, "fork-fix.txt", "own fork\n", "own topic");
		await seed.pushFastForward("fork", "topic", forkHead);

		const checkout = await newRepo("checkout");
		await checkout.addRemote("upstream", upstream.cwd);
		await checkout.addRemote("fork", fork.cwd);
		await checkout.fetch("upstream", ["+refs/heads/main:refs/remotes/upstream/main"]);
		await checkout.fetch("fork", ["+refs/heads/topic:refs/remotes/fork/topic"]);

		const metadata = pullRequest({
			number: 42,
			headSha: prHead,
			baseRef: "release",
			headRef: "topic",
			headRepo: "outside/contributor",
		});
		const outcome = await resolve(
			checkout,
			{ type: "pr", number: 42 },
			mainHead,
			snapshot(),
			github({ pullRequests: { 42: metadata } }),
		);

		if (outcome.status !== "apply") throw new Error("expected the open pull request to apply");
		expect(outcome.contribution.branch).toBe("upstream/project#42");
		await checkout.checkoutDetached(mainHead);
		expect(await checkout.applyDelta(outcome.contribution.base, outcome.contribution.head)).toBeUndefined();
		expect(await Bun.file(join(checkout.cwd, "upstream-fix.txt")).text()).toBe("third party\n");
		expect(await Bun.file(join(checkout.cwd, "release.txt")).exists()).toBe(false);
		expect(await Bun.file(join(checkout.cwd, "fork-fix.txt")).exists()).toBe(false);
	});

	test("fetches an explicit PR after its head repository was deleted", async () => {
		const upstream = await newBareRepo("deleted-head-upstream");
		const seed = await newRepo("deleted-head-seed");
		await seed.addRemote("upstream", upstream.cwd);

		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.pushFastForward("upstream", "main", base);
		await seed.git(["checkout", "--quiet", "-b", "deleted-topic", base]);
		const head = await commitFile(seed, "fix.txt", "retained by upstream\n", "fix");
		await pushRef(seed, "upstream", head, "refs/pull/43/head");

		const checkout = await newRepo("deleted-head-checkout");
		await checkout.addRemote("upstream", upstream.cwd);
		await checkout.fetch("upstream", ["+refs/heads/main:refs/remotes/upstream/main"]);
		const outcome = await resolve(
			checkout,
			{ type: "pr", number: 43 },
			base,
			snapshot(),
			github({
				pullRequests: {
					43: pullRequest({
						number: 43,
						headSha: head,
						headRef: "deleted-topic",
						headRepo: undefined,
					}),
				},
			}),
		);

		if (outcome.status !== "apply") throw new Error("expected the retained pull ref to apply");
		await checkout.checkoutDetached(base);
		expect(await checkout.applyDelta(outcome.contribution.base, outcome.contribution.head)).toBeUndefined();
		expect(await Bun.file(join(checkout.cwd, "fix.txt")).text()).toBe("retained by upstream\n");
	});

	test("resolves a deleted fork branch through its own PR, not another author's same-named branch", async () => {
		const upstream = await newBareRepo("branch-upstream");
		const fork = await newBareRepo("branch-fork");
		const seed = await newRepo("branch-seed");
		await seed.addRemote("upstream", upstream.cwd);
		await seed.addRemote("fork", fork.cwd);

		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.pushFastForward("upstream", "main", base);
		await seed.git(["checkout", "--quiet", "-b", "topic", base]);
		const head = await commitFile(seed, "fork.txt", "fork contribution\n", "fork contribution");
		await seed.pushFastForward("fork", "topic", head);
		await pushRef(seed, "upstream", head, "refs/pull/4/head");
		await seed.git(["push", "--quiet", "fork", ":refs/heads/topic"]);

		const checkout = await newRepo("branch-checkout");
		await checkout.addRemote("upstream", upstream.cwd);
		await checkout.addRemote("fork", fork.cwd);
		await checkout.fetch("upstream", ["+refs/heads/main:refs/remotes/upstream/main"]);

		const matchingOwnPull = pullRequest({
			number: 4,
			headSha: head,
			headRepo: FORK_REPOSITORY,
			headRef: "topic",
		});
		const sameNamedThirdPartyPull = pullRequest({
			number: 5,
			headSha: "f".repeat(40),
			headRepo: "outside/contributor",
			headRef: "topic",
			baseRef: "not-fetched",
		});
		const outcome = await resolve(
			checkout,
			{ type: "branch", name: "topic" },
			base,
			snapshot([sameNamedThirdPartyPull]),
			github({ branchPullRequest: matchingOwnPull }),
		);

		if (outcome.status !== "apply") throw new Error("expected the fork branch to apply");
		await checkout.checkoutDetached(base);
		expect(await checkout.applyDelta(outcome.contribution.base, outcome.contribution.head)).toBeUndefined();
		expect(await Bun.file(join(checkout.cwd, "fork.txt")).text()).toBe("fork contribution\n");
	});

	test("retains a merged PR delta until shipped and skips it after its branch is deleted", async () => {
		const upstream = await newBareRepo("merged-upstream");
		const seed = await newRepo("merged-seed");
		await seed.addRemote("upstream", upstream.cwd);

		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.pushFastForward("upstream", "main", base);
		await seed.git(["checkout", "--quiet", "-b", "topic", base]);
		const head = await commitFile(seed, "fix.txt", "keep this delta\n", "topic fix");
		await pushRef(seed, "upstream", head, "refs/pull/7/head");
		await seed.git(["checkout", "--quiet", "main"]);
		await seed.merge("topic", "merge pull request #7");
		const merge = await seed.revParse("HEAD");
		await seed.pushFastForward("upstream", "main", merge);

		const metadata = pullRequest({
			number: 7,
			headSha: head,
			headRepo: FORK_REPOSITORY,
			headRef: "topic",
			state: "closed",
			merged: true,
			mergeCommitSha: merge,
		});
		const unshipped = await newRepo("merged-unshipped");
		await unshipped.addRemote("upstream", upstream.cwd);
		await unshipped.fetch("upstream", [base]);
		const unshippedOutcome = await resolve(
			unshipped,
			{ type: "pr", number: 7 },
			base,
			snapshot(),
			github({ pullRequests: { 7: metadata } }),
		);

		if (unshippedOutcome.status !== "apply") throw new Error("expected the unshipped merge to apply");
		await unshipped.checkoutDetached(base);
		expect(await unshipped.applyDelta(unshippedOutcome.contribution.base, unshippedOutcome.contribution.head)).toBeUndefined();
		expect(await Bun.file(join(unshipped.cwd, "fix.txt")).text()).toBe("keep this delta\n");
		await seed.git(["push", "--quiet", "upstream", ":refs/pull/7/head"]);

		const shipped = await newRepo("merged-shipped");
		await shipped.addRemote("upstream", upstream.cwd);
		await shipped.addRemote("fork", (await newBareRepo("deleted-merged-fork")).cwd);
		await shipped.fetch("upstream", ["+refs/heads/main:refs/remotes/upstream/main"]);
		const shippedOutcome = await resolve(
			shipped,
			{ type: "branch", name: "topic" },
			merge,
			snapshot(),
			github({ branchPullRequest: metadata }),
		);

		expect(shippedOutcome).toMatchObject({ status: "skip", branch: "topic" });

		const shippedPullRequestOutcome = await resolve(
			shipped,
			{ type: "pr", number: 7 },
			merge,
			snapshot(),
			github({ pullRequests: { 7: metadata } }),
		);
		expect(shippedPullRequestOutcome).toMatchObject({ status: "skip", branch: "upstream/project#7" });
	});

	test("a merged PR shipped as a backport is skipped as shipped, not failed", async () => {
		const upstream = await newBareRepo("backport-upstream");
		const fork = await newBareRepo("backport-fork");
		const seed = await newRepo("backport-seed");
		await seed.addRemote("upstream", upstream.cwd);

		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.git(["checkout", "--quiet", "-b", "topic", base]);
		const head = await commitFile(seed, "fix.txt", "the fix\n", "topic fix");
		await pushRef(seed, "upstream", head, "refs/pull/9/head");
		await seed.git(["checkout", "--quiet", "main"]);
		await seed.merge("topic", "merge pull request #9");
		const merge = await seed.revParse("HEAD");
		await seed.pushFastForward("upstream", "main", merge);

		// A release line cut before the merge, carrying the fix as its own commit.
		await seed.git(["checkout", "--quiet", "-b", "release", base]);
		await commitFile(seed, "release.txt", "release\n", "release prep");
		await seed.git(["cherry-pick", "--quiet", head]);
		const backported = await seed.revParse("HEAD");
		expect(await seed.isAncestor(merge, backported)).toBe(false);
		await seed.pushFastForward("upstream", "release", backported);

		const checkout = await newRepo("backport-checkout");
		await checkout.addRemote("upstream", upstream.cwd);
		await checkout.addRemote("fork", fork.cwd);
		const client = github({
			pullRequests: {
				9: pullRequest({ number: 9, headSha: head, state: "closed", merged: true, mergeCommitSha: merge }),
			},
		});
		const config: RepoConfig = {
			fork: FORK_REPOSITORY,
			upstream: { repository: UPSTREAM_REPOSITORY, branch: "main" },
			branches: [],
			configDir: checkout.cwd,
		};
		const rule: BranchRule = {
			name: "my",
			track: { kind: "branch", branch: "release" },
			contributions: [{ type: "pr", number: 9 }],
			onConflict: "fail",
		};

		const composed = await composeBranch(rule, config, checkout, snapshot(), client, undefined);
		expect(composed.commit).toBe(backported);
		expect(composed.applied).toEqual([]);
		expect(composed.skipped).toMatchObject([{ branch: "upstream/project#9" }]);
	});

	test("does not fall back to a same-named fork branch when an explicit PR is missing", async () => {
		const upstream = await newBareRepo("missing-upstream");
		const fork = await newBareRepo("missing-fork");
		const seed = await newRepo("missing-seed");
		await seed.addRemote("upstream", upstream.cwd);
		await seed.addRemote("fork", fork.cwd);

		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.pushFastForward("upstream", "main", base);
		await seed.git(["checkout", "--quiet", "-b", "99", base]);
		const fallback = await commitFile(seed, "fallback.txt", "must not apply\n", "fallback branch");
		await seed.pushFastForward("fork", "99", fallback);

		const checkout = await newRepo("missing-checkout");
		await checkout.addRemote("upstream", upstream.cwd);
		await checkout.addRemote("fork", fork.cwd);
		await checkout.fetch("upstream", ["+refs/heads/main:refs/remotes/upstream/main"]);
		await checkout.fetch("fork", ["+refs/heads/99:refs/remotes/fork/99"]);
		const missing = new GitHubError("Pull request #99 does not exist in upstream/project", 404);
		const client = {
			getPullRequest: async () => {
				throw missing;
			},
			findPullRequestForBranch: async () => undefined,
		} as unknown as GitHub;

		await expect(
			resolve(checkout, { type: "pr", number: 99 }, base, snapshot(), client),
		).rejects.toBe(missing);
	});

	test("rejects a PR whose upstream pull ref moved after metadata was read", async () => {
		const upstream = await newBareRepo("mismatch-upstream");
		const seed = await newRepo("mismatch-seed");
		await seed.addRemote("upstream", upstream.cwd);

		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.pushFastForward("upstream", "main", base);
		await seed.git(["checkout", "--quiet", "-b", "topic", base]);
		const actualHead = await commitFile(seed, "fix.txt", "actual head\n", "actual head");
		await pushRef(seed, "upstream", actualHead, "refs/pull/8/head");

		const checkout = await newRepo("mismatch-checkout");
		await checkout.addRemote("upstream", upstream.cwd);
		await checkout.fetch("upstream", ["+refs/heads/main:refs/remotes/upstream/main"]);
		const metadata = pullRequest({ number: 8, headSha: "f".repeat(40) });

		await expect(
			resolve(
				checkout,
				{ type: "pr", number: 8 },
				base,
				snapshot(),
				github({ pullRequests: { 8: metadata } }),
			),
		).rejects.toBeInstanceOf(PullRequestHeadMismatchError);
	});

	test("keeps manual, unmerged and reused branches after an earlier squash merge", async () => {
		const upstream = await newBareRepo("reused-upstream");
		const fork = await newBareRepo("reused-fork");
		const seed = await newRepo("reused-seed");
		await seed.addRemote("upstream", upstream.cwd);
		await seed.addRemote("fork", fork.cwd);
		const base = await commitFile(seed, "base.txt", "base\n", "base");
		await seed.git(["checkout", "-b", "topic"]);
		const head = await commitFile(seed, "patch.txt", "patch\n", "patch");
		await seed.pushFastForward("fork", "topic", head);
		await pushRef(seed, "upstream", head, "refs/pull/20/head");
		await seed.checkoutDetached(base);
		const merged = await commitFile(seed, "patch.txt", "patch\n", "squash merge");
		await seed.pushFastForward("upstream", "main", merged);
		const metadata = pullRequest({ number: 20, headSha: head, headRepo: FORK_REPOSITORY,
			merged: true, state: "closed", mergeCommitSha: merged });
		const checkout = await newRepo("reused-checkout");
		await checkout.addRemote("upstream", upstream.cwd);
		await checkout.addRemote("fork", fork.cwd);
		await checkout.fetch("upstream", ["+refs/heads/main:refs/remotes/upstream/main"]);
		const client = github({ branchPullRequest: metadata });
		const spec: ContributionSpec = { type: "branch", name: "topic" };
		expect((await resolve(checkout, spec, merged, snapshot(), client)).status).toBe("skip");
		expect((await resolve(checkout, { ...spec, cleanup: "manual", base }, merged, snapshot(), client)).status).toBe("apply");
		metadata.merged = false;
		metadata.state = "open";
		expect((await resolve(checkout, spec, merged, snapshot(), client)).status).toBe("apply");
		metadata.state = "closed";
		expect((await resolve(checkout, spec, merged, snapshot(), client)).status).toBe("apply");
		metadata.merged = true;
		const next = await commitFile(seed, "new.txt", "new work\n", "reuse topic");
		await seed.git(["push", "--force", "fork", `${next}:refs/heads/topic`]);
		const outcome = await resolve(checkout, spec, merged, snapshot(), client);
		if (outcome.status !== "apply") throw new Error("reused branch must not be removed");
		await checkout.checkoutDetached(merged);
		expect(await checkout.applyDelta(outcome.contribution.base, outcome.contribution.head)).toBeUndefined();
		expect(await Bun.file(join(checkout.cwd, "new.txt")).text()).toBe("new work\n");
	});
});
