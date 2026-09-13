import { describe, expect, mock, test } from "bun:test";
import { cleanedConfig, hasConfigCleanup, publishConfigCleanup } from "../src/config/cleanup.ts";
import type { ArtifactBranch, RepositoryArtifact } from "../src/engine/artifact.ts";
import { GitHubError } from "../src/github/client.ts";
import { RepoConfigFile } from "../src/config/schema.ts";

const manifest = `# My fork
fork: me/project
upstream:
  repository: upstream/project
  branch: main
branches:
  my:
    track: { branch: main }
    contributions:
      - type: branch
        name: shipped
      - type: branch
        name: pending # keep this patch
    on_conflict: ai
  stable:
    track:
      tags: { match: '^v[0-9]+$' }
    contributions: [{type: branch, name: shipped}, {type: branch, name: pending}]
`;

function artifact(): RepositoryArtifact {
	const branch: ArtifactBranch = {
		name: "my", source: { ref: "main", fetchSpec: "refs/heads/main", kind: "branch" },
		sourceCommit: "source", commit: "commit", applied: ["pending"],
		skipped: [{ branch: "shipped", reason: "merged and shipped" }], changed: false,
	};
	return {
		repository: "me/project", upstreamRepository: "upstream/project",
		config: { path: "repositories/me/project/forkit.yaml", content: manifest },
		branches: [branch, { ...branch, name: "stable", skipped: [], applied: ["shipped", "pending"] }],
	};
}

function client(content = manifest) {
	return {
		readRepositoryFile: mock(async () => ({ sha: "current-sha", content })),
		updateRepositoryFile: mock(async (..._args: unknown[]) => {}),
	};
}

describe("manifest cleanup", () => {
	test("cleans unchanged targets individually, preserving comments and settings", () => {
		const input = artifact();
		expect(hasConfigCleanup(input)).toBe(true);
		const output = cleanedConfig(input)!;
		const config = RepoConfigFile.parse(Bun.YAML.parse(output));
		expect(config.branches.my!.contributions).toEqual([{ type: "branch", name: "pending" }]);
		expect(config.branches.stable!.contributions).toEqual([{ type: "branch", name: "shipped" }, { type: "branch", name: "pending" }]);
		expect(config.branches.my!.on_conflict).toBe("ai");
		expect(output).toContain("# My fork");
		expect(output).toContain("# keep this patch");
		expect(output).toContain("'^v[0-9]+$'");
		expect(input.config!.content).toBe(manifest);
	});

	test("removes shipped PRs while retaining manual and unshipped entries", () => {
		const input = artifact();
		const config = RepoConfigFile.parse(Bun.YAML.parse(manifest));
		config.branches.my!.contributions = [
			{ type: "pr", number: 39512 },
			{ type: "pr", number: 39513, cleanup: "manual" },
			{ type: "branch", name: "pending" },
		];
		input.config!.content = JSON.stringify(config);
		input.branches[0]!.skipped = [
			{ branch: "upstream/project#39512", reason: "shipped" },
			{ branch: "upstream/project#39513", reason: "manual entries must survive" },
		];
		const result = RepoConfigFile.parse(Bun.YAML.parse(cleanedConfig(input)!));
		expect(result.branches.my!.contributions).toEqual([
			{ type: "pr", number: 39513, cleanup: "manual" },
			{ type: "branch", name: "pending" },
		]);
	});

	test("removing the last contribution leaves a valid empty list and keeps the target", () => {
		const input = artifact();
		input.branches[0]!.skipped.push({ branch: "pending", reason: "shipped too" });
		const config = RepoConfigFile.parse(Bun.YAML.parse(cleanedConfig(input)!));
		expect(config.branches.my!.contributions).toEqual([]);
		expect(config.branches.my!.track).toEqual({ branch: "main" });
	});

	test("no skipped contributions means no cleanup or API access", async () => {
		const input = artifact();
		input.branches[0]!.skipped = [];
		const github = client();
		expect(cleanedConfig(input)).toBeUndefined();
		expect(await publishConfigCleanup(input, github, "me/forkit", "main", false)).toBe(false);
		expect(github.readRepositoryFile).not.toHaveBeenCalled();
	});


	test("dry runs never read or write the remote manifest", async () => {
		const github = client();
		expect(await publishConfigCleanup(artifact(), github, "me/forkit", "main", true)).toBe(false);
		expect(github.readRepositoryFile).not.toHaveBeenCalled();
		expect(github.updateRepositoryFile).not.toHaveBeenCalled();
	});

	test("refuses a manifest edited after composition", async () => {
		const github = client(manifest.replace("branch: main", "branch: next"));
		await expect(publishConfigCleanup(artifact(), github, "me/forkit", "main", false))
			.rejects.toThrow("changed since composition");
		expect(github.updateRepositoryFile).not.toHaveBeenCalled();
	});

	test("already committed cleanup is idempotent", async () => {
		const input = artifact();
		const github = client(cleanedConfig(input));
		expect(await publishConfigCleanup(input, github, "me/forkit", "main", false)).toBe(false);
		expect(github.updateRepositoryFile).not.toHaveBeenCalled();
	});

	test("retries conflicts caused by other repository commits", async () => {
		const github = client();
		github.updateRepositoryFile.mockRejectedValueOnce(new GitHubError("conflict", 409));
		expect(await publishConfigCleanup(artifact(), github, "me/forkit", "main", false)).toBe(true);
		expect(github.readRepositoryFile).toHaveBeenCalledTimes(2);
		expect(github.updateRepositoryFile).toHaveBeenCalledTimes(2);
	});

	test("a concurrent edit during retry is never overwritten", async () => {
		const github = client();
		github.readRepositoryFile.mockResolvedValueOnce({ sha: "first", content: manifest });
		github.readRepositoryFile.mockResolvedValue({ sha: "second", content: `${manifest}# user edit\n` });
		github.updateRepositoryFile.mockRejectedValueOnce(new GitHubError("conflict", 409));
		await expect(publishConfigCleanup(artifact(), github, "me/forkit", "main", false))
			.rejects.toThrow("changed since composition");
		expect(github.updateRepositoryFile).toHaveBeenCalledTimes(1);
	});
});
