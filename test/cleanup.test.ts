import { describe, expect, mock, test } from "bun:test";
import { cleanedConfig, hasConfigCleanup, publishConfigCleanup } from "../src/config/cleanup.ts";
import type { ArtifactBranch, RepositoryArtifact } from "../src/engine/artifact.ts";
import { GitHubError } from "../src/github/client.ts";

const manifest = `# My fork
fork: me/project
upstream:
  repository: upstream/project
  branch: main
branches:
  my:
    track: { branch: main }
    contributions:
      - shipped
      - pending # keep this patch
    on_conflict: ai
  stable:
    track:
      tags: { match: '^v[0-9]+$' }
    contributions: [shipped, pending]
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
		const config = Bun.YAML.parse(output) as any;
		expect(config.branches.my.contributions).toEqual(["pending"]);
		expect(config.branches.stable.contributions).toEqual(["shipped", "pending"]);
		expect(config.branches.my.on_conflict).toBe("ai");
		expect(output).toContain("# My fork");
		expect(output).toContain("# keep this patch");
		expect(output).toContain("'^v[0-9]+$'");
		expect(input.config!.content).toBe(manifest);
	});

	test("removing the last contribution leaves a valid empty list and keeps the target", () => {
		const input = artifact();
		input.branches[0]!.skipped.push({ branch: "pending", reason: "shipped too" });
		const config = Bun.YAML.parse(cleanedConfig(input)!) as any;
		expect(config.branches.my.contributions).toEqual([]);
		expect(config.branches.my.track).toEqual({ branch: "main" });
	});

	test("no skipped contributions means no cleanup or API access", async () => {
		const input = artifact();
		input.branches[0]!.skipped = [];
		const github = client();
		expect(cleanedConfig(input)).toBeUndefined();
		expect(await publishConfigCleanup(input, github, "me/forkit", "main", false)).toBe(false);
		expect(github.readRepositoryFile).not.toHaveBeenCalled();
	});

	test("commits only the manifest using its current SHA", async () => {
		const input = artifact();
		const github = client();
		expect(await publishConfigCleanup(input, github, "me/forkit", "maintenance", false)).toBe(true);
		expect(github.updateRepositoryFile).toHaveBeenCalledWith(
			"me/forkit", "maintenance", input.config!.path, "current-sha", cleanedConfig(input),
			"chore: remove shipped contributions from me/project",
		);
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
