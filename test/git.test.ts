import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../src/git/git.ts";
import { checkResolution } from "../src/git/gates.ts";

/** A throwaway repository with deterministic identity and no signing. */
async function newRepo(): Promise<Git> {
	const dir = await mkdtemp(join(tmpdir(), "forkit-git-"));
	const git = new Git(dir);
	await git.git(["init", "--quiet", "--initial-branch=main"]);
	await git.git(["config", "user.name", "forkit-test"]);
	await git.git(["config", "user.email", "forkit-test@example.invalid"]);
	await git.git(["config", "commit.gpgsign", "false"]);
	return git;
}

async function commitFile(git: Git, path: string, contents: string, message: string): Promise<string> {
	await Bun.write(join(git.cwd, path), contents);
	await git.git(["add", path]);
	await git.git(["commit", "--quiet", "--no-verify", "-m", message]);
	return git.revParse("HEAD");
}

describe("Git primitives", () => {
	test("revParse, exists, and ancestry", async () => {
		const git = await newRepo();
		const first = await commitFile(git, "a.txt", "one\n", "first");
		const second = await commitFile(git, "a.txt", "two\n", "second");

		expect(first).toHaveLength(40);
		expect(await git.exists("HEAD")).toBe(true);
		expect(await git.exists("refs/heads/nope")).toBe(false);
		expect(await git.isAncestor(first, second)).toBe(true);
		expect(await git.isAncestor(second, first)).toBe(false);
		expect(await git.mergeBase(first, second)).toBe(first);
	});

	test("applyDelta transplants only the contribution's own change", async () => {
		const git = await newRepo();
		const base = await commitFile(git, "app.txt", "line1\nline2\n", "base");

		// A contribution branch that also carries unrelated upstream work.
		await git.git(["checkout", "--quiet", "-b", "topic"]);
		await commitFile(git, "unrelated.txt", "noise\n", "unrelated upstream commit");
		const head = await commitFile(git, "feature.txt", "my feature\n", "the contribution");

		// A release that never saw either commit.
		await git.git(["checkout", "--quiet", "--detach", base]);
		const contributionBase = await git.mergeBase(base, head);

		// Only the delta from the merge-base of the *contribution* is wanted.
		const conflict = await git.applyDelta(await git.revParse("topic~1"), head);
		expect(conflict).toBeUndefined();
		expect(await Bun.file(join(git.cwd, "feature.txt")).text()).toBe("my feature\n");
		// The unrelated commit did not come along.
		expect(await Bun.file(join(git.cwd, "unrelated.txt")).exists()).toBe(false);
		expect(contributionBase).toBe(base);
	});

	test("applyDelta reports conflicts and leaves markers", async () => {
		const git = await newRepo();
		await commitFile(git, "shared.txt", "original\n", "base");

		await git.git(["checkout", "--quiet", "-b", "topic"]);
		const topicHead = await commitFile(git, "shared.txt", "from the contribution\n", "topic edit");
		const topicBase = await git.revParse("topic~1");

		await git.git(["checkout", "--quiet", "main"]);
		await commitFile(git, "shared.txt", "from upstream\n", "upstream edit");

		const conflict = await git.applyDelta(topicBase, topicHead);
		expect(conflict?.paths).toEqual(["shared.txt"]);
		expect(await Bun.file(join(git.cwd, "shared.txt")).text()).toContain("<<<<<<<");
	});

	test("merge succeeds cleanly when edits do not overlap", async () => {
		const git = await newRepo();
		await commitFile(git, "a.txt", "a\n", "base");

		await git.git(["checkout", "--quiet", "-b", "other"]);
		await commitFile(git, "b.txt", "b\n", "other side");

		await git.git(["checkout", "--quiet", "main"]);
		await commitFile(git, "c.txt", "c\n", "our side");

		expect(await git.merge("other", "merge other")).toBeUndefined();
		expect(await git.isClean()).toBe(true);
	});

	test("changedPaths includes untracked files", async () => {
		const git = await newRepo();
		const base = await commitFile(git, "a.txt", "a\n", "base");

		await Bun.write(join(git.cwd, "a.txt"), "modified\n");
		await Bun.write(join(git.cwd, "new.txt"), "new\n");

		expect(await git.changedPaths(base)).toEqual(["a.txt", "new.txt"]);
	});

	test("pushWithLease refuses a remote that moved", async () => {
		const originDir = await mkdtemp(join(tmpdir(), "forkit-origin-"));
		const origin = new Git(originDir);
		await origin.git(["init", "--quiet", "--bare", "--initial-branch=main"]);

		const git = await newRepo();
		await git.addRemote("origin", originDir);
		const first = await commitFile(git, "a.txt", "one\n", "first");
		await git.pushFastForward("origin", "main", first);

		// Someone else advances the remote after we observed `first`.
		const other = await newRepo();
		await other.addRemote("origin", originDir);
		await other.git(["fetch", "origin", "main"]);
		await other.git(["checkout", "--quiet", "-B", "main", "FETCH_HEAD"]);
		const theirs = await commitFile(other, "a.txt", "theirs\n", "concurrent");
		await other.pushFastForward("origin", "main", theirs);

		const ours = await commitFile(git, "a.txt", "ours\n", "ours");
		expect(git.pushWithLease("origin", "main", ours, first)).rejects.toThrow();

		// With the real tip it succeeds.
		expect(await git.remoteTip("origin", "main")).toBe(theirs);
		await git.pushWithLease("origin", "main", ours, theirs);
		expect(await git.remoteTip("origin", "main")).toBe(ours);
	});

	test("remoteTip is undefined for a missing branch", async () => {
		const originDir = await mkdtemp(join(tmpdir(), "forkit-origin2-"));
		const origin = new Git(originDir);
		await origin.git(["init", "--quiet", "--bare", "--initial-branch=main"]);

		const git = await newRepo();
		await git.addRemote("origin", originDir);
		expect(await git.remoteTip("origin", "absent")).toBeUndefined();
	});

	test("same tree, parent, identity, date, and message produce the same commit", async () => {
		const git = await newRepo();
		const base = await commitFile(git, "a.txt", "base\n", "base");
		const date = "2026-07-01T12:34:56+00:00";
		const message = "generated\n\nForkit-Input: sha256:abc";

		await Bun.write(join(git.cwd, "a.txt"), "generated\n");
		const first = await git.commitAll(message, { date });

		await git.checkoutDetached(base);
		await Bun.write(join(git.cwd, "a.txt"), "generated\n");
		const second = await git.commitAll(message, { date });

		expect(second).toBe(first);
		expect(await git.trailer(second, "Forkit-Input")).toBe("sha256:abc");
	});
});

describe("resolution gates", () => {
	test("pass for a correctly resolved conflict", async () => {
		const git = await newRepo();
		await commitFile(git, "shared.txt", "original\n", "base");
		await git.git(["checkout", "--quiet", "-b", "topic"]);
		const head = await commitFile(git, "shared.txt", "theirs\n", "topic");
		const base = await git.revParse("topic~1");

		await git.git(["checkout", "--quiet", "main"]);
		const baseline = await commitFile(git, "shared.txt", "ours\n", "upstream");

		const conflict = await git.applyDelta(base, head);
		expect(conflict).toBeDefined();

		await Bun.write(join(git.cwd, "shared.txt"), "ours and theirs\n");
		await git.git(["add", "shared.txt"]);

		expect(await checkResolution(git, conflict!.paths, baseline)).toEqual([]);
	});

	test("catch leftover conflict markers", async () => {
		const git = await newRepo();
		const baseline = await commitFile(git, "shared.txt", "ours\n", "base");
		await Bun.write(join(git.cwd, "shared.txt"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n");
		await git.git(["add", "shared.txt"]);

		const failures = await checkResolution(git, ["shared.txt"], baseline);
		expect(failures.map((f) => f.gate)).toContain("conflict-markers");
	});

	test("catch edits outside the conflicted set", async () => {
		const git = await newRepo();
		const baseline = await commitFile(git, "shared.txt", "ours\n", "base");

		await Bun.write(join(git.cwd, "shared.txt"), "resolved\n");
		await Bun.write(join(git.cwd, "elsewhere.txt"), "should not be here\n");

		const failures = await checkResolution(git, ["shared.txt"], baseline);
		const outOfScope = failures.find((f) => f.gate === "out-of-scope-edits");
		expect(outOfScope?.detail).toContain("elsewhere.txt");
	});

	test("catch an unmerged index", async () => {
		const git = await newRepo();
		await commitFile(git, "shared.txt", "original\n", "base");
		await git.git(["checkout", "--quiet", "-b", "topic"]);
		const head = await commitFile(git, "shared.txt", "theirs\n", "topic");
		const base = await git.revParse("topic~1");

		await git.git(["checkout", "--quiet", "main"]);
		const baseline = await commitFile(git, "shared.txt", "ours\n", "upstream");
		await git.applyDelta(base, head);

		// Left exactly as git produced it: markers present, index unmerged.
		const gates = (await checkResolution(git, ["shared.txt"], baseline)).map((f) => f.gate);
		expect(gates).toContain("unmerged-entries");
		expect(gates).toContain("conflict-markers");
	});
});
