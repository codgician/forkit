import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, discoverConfigFiles, loadConfig } from "../src/config/load.ts";

async function writeConfig(body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "forkit-cfg-"));
	const path = join(dir, "forkit.yaml");
	await writeFile(path, body);
	return path;
}

const BASE = `
fork: codgician/litellm
upstream:
  repository: BerriAI/litellm
  branch: litellm_internal_staging
branches:
`;

describe("loadConfig", () => {
	test("resolves the real litellm config", async () => {
		const config = await loadConfig("repositories/codgician/litellm/forkit.yaml");

		expect(config.fork).toBe("codgician/litellm");
		expect(config.upstream.branch).toBe("litellm_internal_staging");

		const main = config.branches.find((b) => b.name === "main");
		// Must be upstream's own main, not the development branch.
		expect(main?.track).toEqual({ kind: "branch", branch: "main" });
		expect(main?.image).toBeUndefined();

		const my = config.branches.find((b) => b.name === "my");
		expect(my?.track).toMatchObject({ kind: "releases", prerelease: "exclude" });
		expect(my?.contributions).toEqual([
			"litellm_configurable_copilot_headers",
			"litellm_update_github_copilot_models",
		]);
		expect(my?.image).toBe("ghcr.io/codgician/litellm");
		// Generated branch: a resolution stays private to the fork.
		expect(my?.onConflict).toBe("ai");
		// A mirror never composes, so it never resolves anything.
		expect(main?.onConflict).toBe("fail");
	});

	test("conflict policy defaults to fail", async () => {
		const path = await writeConfig(`${BASE}  my:\n    track:\n      releases: {}\n`);
		const config = await loadConfig(path);

		expect(config.branches[0]?.onConflict).toBe("fail");
	});

	test("`branch: upstream` is shorthand for the development branch", async () => {
		const path = await writeConfig(`${BASE}  main:\n    track:\n      branch: upstream\n`);
		const config = await loadConfig(path);
		expect(config.branches[0]?.track).toEqual({ kind: "branch", branch: "litellm_internal_staging" });
	});

	test("release match compiles to a regex that selects stable tags only", async () => {
		const config = await loadConfig("repositories/codgician/litellm/forkit.yaml");
		const track = config.branches.find((b) => b.name === "my")?.track;
		if (track?.kind !== "releases" || !track.match) throw new Error("expected a release matcher");

		expect(track.match.test("v1.94.0")).toBe(true);
		expect(track.match.test("v1.95.0-rc.1")).toBe(false);
		expect(track.match.test("v1.95.0-dev.2")).toBe(false);
	});

	test("rejects a mirror branch that declares contributions", async () => {
		const path = await writeConfig(
			`${BASE}  main:\n    track:\n      branch: upstream\n    contributions: [topic]\n`,
		);
		expect(loadConfig(path)).rejects.toThrow(/cannot declare/);
	});

	test("rejects more than one tracking form", async () => {
		const path = await writeConfig(
			`${BASE}  my:\n    track:\n      branch: main\n      tags:\n        match: 'v.*'\n`,
		);
		expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("rejects duplicate contributions", async () => {
		const path = await writeConfig(
			`${BASE}  my:\n    track:\n      releases: {}\n    contributions: [topic, topic]\n`,
		);
		expect(loadConfig(path)).rejects.toThrow(/more than once/);
	});

	test("rejects two branches publishing the same moving tag", async () => {
		const path = await writeConfig(
			`${BASE}` +
				`  "feat/x":\n    track:\n      releases: {}\n    container:\n      image: ghcr.io/x/y\n` +
				`  "feat-x":\n    track:\n      releases: {}\n    container:\n      image: ghcr.io/x/y\n`,
		);
		// "feat/x" normalises to "feat-x", colliding with the literal branch.
		expect(loadConfig(path)).rejects.toThrow(/both publish/);
	});

	test("rejects an invalid regex", async () => {
		const path = await writeConfig(
			`${BASE}  my:\n    track:\n      releases:\n        match: '([unclosed'\n`,
		);
		expect(loadConfig(path)).rejects.toThrow(/regular expression/);
	});

	test("rejects unknown keys", async () => {
		const path = await writeConfig(`${BASE}  my:\n    track:\n      releases: {}\n    typo: true\n`);
		expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("rejects a fork that equals its upstream", async () => {
		const path = await writeConfig(
			`fork: a/b\nupstream:\n  repository: a/b\n  branch: main\nbranches:\n  main:\n    track:\n      branch: main\n`,
		);
		expect(loadConfig(path)).rejects.toThrow(/must differ/);
	});
});

describe("discoverConfigFiles", () => {
	test("finds the litellm config in this repository", async () => {
		expect(await discoverConfigFiles(".")).toEqual([
			"repositories/codgician/litellm/forkit.yaml",
		]);
	});

	test("returns nothing when there is no repositories directory", async () => {
		const empty = await mkdtemp(join(tmpdir(), "forkit-empty-"));
		expect(await discoverConfigFiles(empty)).toEqual([]);
	});

	test("ignores a directory without a forkit.yaml", async () => {
		const root = await mkdtemp(join(tmpdir(), "forkit-root-"));
		await mkdir(join(root, "repositories", "owner", "repo"), { recursive: true });
		expect(await discoverConfigFiles(root)).toEqual([]);
	});
});
