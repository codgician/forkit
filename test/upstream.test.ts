import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../src/git/git.ts";
import { GitHub } from "../src/github/client.ts";
import { loadConfig } from "../src/config/load.ts";
import { createRepositoryArtifact, publishRepositoryArtifact } from "../src/engine/artifact.ts";
import { composeBranch } from "../src/engine/compose.ts";
import { resolveContribution } from "../src/engine/contribution.ts";
import { upstreamSnapshot } from "../src/engine/upstream.ts";
import { resolveSource } from "../src/engine/source.ts";
import type { RepoConfig } from "../src/config/types.ts";

const directories: string[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function commit(git: Git, file: string, text: string): Promise<string> {
	await Bun.write(join(git.cwd, file), text);
	return git.commitAll(file);
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "forkit-upstream-"));
	directories.push(root);
	const upstream = new Git(join(root, "upstream"));
	const fork = new Git(join(root, "fork"));
	await mkdir(upstream.cwd);
	await mkdir(fork.cwd);
	await upstream.git(["init", "-q", "--initial-branch=ec-legacy"]);
	await upstream.git(["config", "user.name", "test"]);
	await upstream.git(["config", "user.email", "test@example.invalid"]);
	await upstream.git(["config", "commit.gpgsign", "false"]);
	await upstream.git(["config", "tag.gpgsign", "false"]);
	await fork.git(["init", "-q", "--bare"]);
	const base = await commit(upstream, "app.txt", "upstream\n");
	await upstream.git(["switch", "-c", "patches/one"]);
	const head = await commit(upstream, "patch.txt", "custom patch\n");
	await upstream.git(["push", fork.cwd, "HEAD:refs/heads/patches/one"]);
	await upstream.git(["switch", "ec-legacy"]);
	const addRemote = Git.prototype.addRemote;
	const remoteSpy = spyOn(Git.prototype, "addRemote").mockImplementation(function (this: Git, name, url) {
		return addRemote.call(this, name, name === "upstream" ? upstream.cwd : name === "fork" ? fork.cwd : url);
	});
	const viewer = spyOn(GitHub.prototype, "viewer").mockResolvedValue({ name: "test", email: "test@example.invalid" });
	const snapshot = spyOn(GitHub.prototype, "snapshot").mockRejectedValue(new Error("Git upstream must not query GitHub metadata"));
	const prs = spyOn(GitHub.prototype, "findPullRequestForBranch").mockRejectedValue(new Error("Permanent patches must not query PRs"));
	restores.push(() => { remoteSpy.mockRestore(); viewer.mockRestore(); snapshot.mockRestore(); prs.mockRestore(); });
	const configDir = join(root, "repositories", "me", "ec");
	await mkdir(configDir, { recursive: true });
	const document = {
		fork: "me/ec", upstream: { git: "https://example.invalid/ec", branch: "ec-legacy" },
		branches: {
			"ec-legacy": { track: { branch: "ec-legacy" } },
			my: { track: { branch: "ec-legacy" }, contributions: [{ type: "branch", name: "patches/one", base, cleanup: "manual" }] },
		},
	};
	const path = join(configDir, "forkit.yaml");
	await Bun.write(path, JSON.stringify(document));
	const config = await loadConfig(path);
	const artifactDir = join(root, "artifact");
	return { root, upstream, fork, base, head, config, artifactDir, snapshot, prs };
}

describe("generic Git upstreams", () => {
	test("composes and publishes an exact mirror plus a permanent patch without upstream API calls", async () => {
		const f = await fixture();
		f.config.branches[1]!.validation = {
			command: [process.execPath, "-e", 'if (await Bun.file(".git").exists()) throw Error("Git metadata leaked"); if ((await Bun.file("patch.txt").text()) !== "custom patch\\n") throw Error("missing patch"); await Bun.write("patch.txt", "build-host adaptation");'],
			timeout_minutes: 1,
		};
		const artifact = await createRepositoryArtifact(f.config, "test-token", undefined, f.artifactDir);
		expect(artifact.failures).toEqual([]);
		expect(artifact.upstreamUrl).toBe("https://example.invalid/ec");
		expect(artifact.branches[0]!.commit).toBe(f.base);
		expect(artifact.branches[1]!.sourceCommit).toBe(f.base);
		expect(artifact.branches[1]!.applied).toEqual(["patches/one"]);
		expect(f.snapshot).not.toHaveBeenCalled();
		expect(f.prs).not.toHaveBeenCalled();
		expect((await publishRepositoryArtifact(f.artifactDir, {}, "test-token", false)).map((r) => r.status)).toEqual(["updated", "updated"]);
		expect(await f.fork.revParse("ec-legacy")).toBe(f.base);
		expect((await f.fork.git(["show", "my:patch.txt"])).stdout).toBe("custom patch\n");
		expect(await f.fork.revParse("patches/one")).toBe(f.head);
		const again = await createRepositoryArtifact(f.config, "test-token", undefined, join(f.root, "again"));
		expect(again.branches.every((branch) => !branch.changed)).toBe(true);
	});

	test("a missing patch fails only its target, including when it is processed first", async () => {
		const f = await fixture();
		f.config.branches.unshift({ name: "broken", track: { kind: "branch", branch: "ec-legacy" }, contributions: [{ type: "branch", name: "missing" }], onConflict: "fail" });
		const artifact = await createRepositoryArtifact(f.config, "test-token", undefined, f.artifactDir);
		expect(artifact.failures?.map((failure) => failure.branch)).toEqual(["broken"]);
		expect(artifact.branches.map((branch) => branch.name)).toEqual(["ec-legacy", "my"]);
		await publishRepositoryArtifact(f.artifactDir, {}, "test-token", false);
		expect(await f.fork.revParse("ec-legacy")).toBe(f.base);
		expect(await f.fork.exists("broken")).toBe(false);
	});

	test("validation failure retains the previous patched target while allowing mirror progress", async () => {
		const f = await fixture();
		await f.upstream.git(["push", f.fork.cwd, "ec-legacy:my"]);
		const next = await commit(f.upstream, "new.txt", "new upstream\n");
		f.config.branches[1]!.validation = { command: [process.execPath, "-e", 'throw Error("firmware check failed")'], timeout_minutes: 1 };
		const artifact = await createRepositoryArtifact(f.config, "test-token", undefined, f.artifactDir);
		expect(artifact.failures?.[0]?.reason).toContain("firmware check failed");
		await publishRepositoryArtifact(f.artifactDir, {}, "test-token", false);
		expect(await f.fork.revParse("ec-legacy")).toBe(next);
		expect(await f.fork.revParse("my")).toBe(f.base);
	});

	test("an actual Git conflict on the first target does not contaminate the mirror", async () => {
		const f = await fixture();
		const next = await commit(f.upstream, "patch.txt", "conflicting upstream change\n");
		f.config.branches.reverse();
		const artifact = await createRepositoryArtifact(f.config, "test-token", undefined, f.artifactDir);
		expect(artifact.failures?.[0]?.reason).toContain("conflicts");
		expect(artifact.branches.map((branch) => branch.name)).toEqual(["ec-legacy"]);
		await publishRepositoryArtifact(f.artifactDir, {}, "test-token", false);
		expect(await f.fork.revParse("ec-legacy")).toBe(next);
	});

	test("a failed container build does not block an independent branch publication", async () => {
		const f = await fixture();
		f.config.branches[1]!.container = { image: "example/image", dockerfile: "Dockerfile", platforms: ["linux/amd64"] };
		await createRepositoryArtifact(f.config, "test-token", undefined, f.artifactDir);
		const results = await publishRepositoryArtifact(f.artifactDir, {}, "test-token", false);
		expect(results.map((result) => result.status)).toEqual(["updated", "failed"]);
		expect(await f.fork.revParse("ec-legacy")).toBe(f.base);
		expect(await f.fork.exists("my")).toBe(false);
	});

	test("targets sharing a moving upstream branch reuse the exact same source observation", async () => {
		const f = await fixture();
		const directory = join(f.root, "compose");
		await mkdir(directory);
		const git = new Git(directory);
		await git.git(["init", "-q"]);
		await git.addRemote("upstream", f.upstream.cwd);
		await git.addRemote("fork", f.fork.cwd);
		const cache = new Map<string, Promise<string>>();
		const snapshot = { releases: [], tags: [], openPullRequests: [] };
		const rule = { ...f.config.branches[0]!, contributions: [] };
		const first = await composeBranch(rule, f.config, git, snapshot, new GitHub(), undefined, cache);
		await commit(f.upstream, "new.txt", "advanced between targets\n");
		const second = await composeBranch({ ...rule, name: "another" }, f.config, git, snapshot, new GitHub(), undefined, cache);
		expect(second.sourceCommit).toBe(first.sourceCommit);
	});

	test("explicit bases isolate stacked patches and reject unrelated base commits", async () => {
		const f = await fixture();
		await f.upstream.git(["switch", "patches/one"]);
		const second = await commit(f.upstream, "second.txt", "second patch\n");
		await f.upstream.addRemote("fork", f.fork.cwd);
		await f.upstream.git(["push", f.fork.cwd, "HEAD:refs/heads/two"]);
		const snapshot = { releases: [], tags: [], openPullRequests: [] };
		const resolved = await resolveContribution({ type: "branch", name: "two", base: f.head, cleanup: "manual" }, f.upstream, "fork", undefined, "me/ec", "ec-legacy", f.base, snapshot, new GitHub());
		if (resolved.status !== "apply") throw Error("expected patch");
		expect(await f.upstream.changedPathsBetween(resolved.contribution.base, resolved.contribution.head)).toEqual(["second.txt"]);
		await expect(resolveContribution({ type: "branch", name: "two", base: "f".repeat(40), cleanup: "manual" }, f.upstream, "fork", undefined, "me/ec", "ec-legacy", f.base, snapshot, new GitHub())).rejects.toThrow("declared base");
	});

	test("Git tags support annotated and lightweight refs without release metadata", async () => {
		const f = await fixture();
		await f.upstream.git(["tag", "v1.0.0"]);
		await f.upstream.git(["tag", "-a", "v2.0.0", "-m", "release"]);
		await f.upstream.git(["tag", "unrelated"]);
		const directory = join(f.root, "tags");
		await mkdir(directory);
		const git = new Git(directory);
		await git.git(["init", "-q"]);
		await git.addRemote("upstream", f.upstream.cwd);
		const track = { kind: "tags" as const, match: /^v/ };
		const config: RepoConfig = { ...f.config, branches: [{ ...f.config.branches[0]!, track }] };
		const snapshot = await upstreamSnapshot(config, git, new GitHub());
		expect(snapshot.tags.sort()).toEqual(["v1.0.0", "v2.0.0"]);
		expect(resolveSource(track, "Git upstream", snapshot).ref).toBe("v2.0.0");
	});
});
