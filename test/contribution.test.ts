import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingContributionError, resolveContribution } from "../src/engine/contribution.ts";
import { Git } from "../src/git/git.ts";
import { GitHub, type PullRequest, type UpstreamSnapshot } from "../src/github/client.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "forkit-contribution-"));
	directories.push(directory);
	const git = new Git(directory);
	await git.git(["init", "--quiet", "--initial-branch=main"]);
	await git.git(["config", "user.name", "test"]);
	await git.git(["config", "user.email", "test@example.invalid"]);
	await git.git(["config", "commit.gpgsign", "false"]);
	await Bun.write(join(directory, "app.txt"), "base\n");
	const base = await git.commitAll("base");
	await Bun.write(join(directory, "patch.txt"), "patch\n");
	const head = await git.commitAll("contribution");
	await git.updateRef("refs/remotes/fork/topic", head);
	// Squash/rebase merges have a different commit ID from the PR head.
	await git.checkoutDetached(base);
	await Bun.write(join(directory, "patch.txt"), "patch\n");
	const merged = await git.commitAll("squash merge PR");
	await git.updateRef("refs/remotes/upstream/main", merged);
	const pull: PullRequest = {
		number: 1, title: "patch", body: "", draft: false, state: "closed", merged: true,
		mergeCommitSha: merged, baseRef: "main", headRepo: "me/project", headRef: "topic", headSha: head,
	};
	const snapshot: UpstreamSnapshot = { releases: [], tags: [], openPullRequests: [] };
	class Client extends GitHub {
		override async findPullRequestForBranch() { return pull; }
	}
	const resolve = (source: string) => resolveContribution(
		"topic", git, "fork", "upstream/project", "me/project", "main", source, snapshot, new Client(),
	);
	return { git, base, head, merged, pull, snapshot, resolve };
}

describe("shipped contribution detection", () => {
	test("skips a merged PR only for sources containing its merge", async () => {
		const f = await fixture();
		expect((await f.resolve(f.base)).status).toBe("apply");
		expect((await f.resolve(f.merged)).status).toBe("skip");
	});

	test("supports a deleted head after shipping, but fails for an older source", async () => {
		const f = await fixture();
		await f.git.git(["update-ref", "-d", "refs/remotes/fork/topic"]);
		expect((await f.resolve(f.merged)).status).toBe("skip");
		await expect(f.resolve(f.base)).rejects.toBeInstanceOf(MissingContributionError);
	});

	test("retains an open or closed-unmerged PR even when its change is present", async () => {
		const f = await fixture();
		f.pull.merged = false;
		f.pull.state = "open";
		f.snapshot.openPullRequests = [f.pull];
		expect((await f.resolve(f.merged)).status).toBe("apply");
		f.pull.state = "closed";
		f.snapshot.openPullRequests = [];
		expect((await f.resolve(f.merged)).status).toBe("apply");
	});

	test("does not remove a branch with commits added after the merged PR", async () => {
		const f = await fixture();
		await f.git.checkoutDetached(f.head);
		await Bun.write(join(f.git.cwd, "new.txt"), "new change\n");
		await f.git.updateRef("refs/remotes/fork/topic", await f.git.commitAll("new contribution"));
		expect((await f.resolve(f.merged)).status).toBe("apply");
	});

	test("does not skip without a verifiable merge commit", async () => {
		const f = await fixture();
		f.pull.mergeCommitSha = undefined;
		expect((await f.resolve(f.merged)).status).toBe("apply");
		f.pull.mergeCommitSha = "f".repeat(40);
		expect((await f.resolve(f.merged)).status).toBe("apply");
	});
});
