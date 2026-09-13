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
	test("loads a Git upstream with explicit permanent patches and validation", async () => {
		const config = await loadConfig("repositories/codgician/redrix-ec/forkit.yaml");
		expect(config.upstream.git).toBe("https://chromium.googlesource.com/chromiumos/platform/ec");
		expect(config.upstream.repository).toBeUndefined();
		const my = config.branches.find((branch) => branch.name === "my")!;
		expect(my.track).toEqual({ kind: "branch", branch: "ec-legacy" });
		expect(my.contributions).toHaveLength(3);
		expect(my.validation?.timeout_minutes).toBe(60);
	});

	test("rejects unsupported Git upstream metadata and ambiguous patch inputs", async () => {
		const base = { fork: "me/ec", upstream: { git: "https://example.com/ec", branch: "main" } };
		for (const rule of [
			{ track: { releases: {} } },
			{ track: { branch: "main" }, contributions: [{ type: "branch", name: "patch", cleanup: "when-merged" }] },
			{ track: { branch: "main" }, contributions: [{ type: "pr", number: 39512 }] },
			{ track: { branch: "main" }, contributions: [{ type: "branch", name: "patch" }, { type: "branch", name: "patch" }] },
			{ track: { branch: "main" }, contributions: [{ type: "branch", name: "patch", base: "moving-ref" }] },
			{ track: { branch: "main" }, contributions: [{ type: "branch", name: "my" }] },
		]) {
			const path = await writeConfig(JSON.stringify({ ...base, branches: { my: rule } }));
			await expect(loadConfig(path)).rejects.toBeInstanceOf(ConfigError);
		}
	});

	test("resolves the real litellm config", async () => {
		const config = await loadConfig("repositories/codgician/litellm/forkit.yaml");

		expect(config.fork).toBe("codgician/litellm");
		expect(config.upstream.branch).toBe("litellm_internal_staging");

		const main = config.branches.find((b) => b.name === "main");
		// Must be upstream's own main, not the development branch.
		expect(main?.track).toEqual({ kind: "branch", branch: "main" });
		expect(main?.container).toBeUndefined();

		const my = config.branches.find((b) => b.name === "my");
		expect(my?.track).toMatchObject({ kind: "releases", prerelease: "exclude" });
		expect(my?.container?.image).toBe("ghcr.io/codgician/litellm");
		expect(my?.container?.dockerfile).toBe("Dockerfile");
		// One tag, both architectures.
		expect(my?.container?.platforms).toEqual(["linux/amd64", "linux/arm64"]);
		expect(my?.container?.smoke?.entrypoint).toBe("litellm");
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

	test("resolves the branch-based proxmox config", async () => {
		const config = await loadConfig("repositories/codgician/proxmox-nixos/forkit.yaml");
		const my = config.branches.find((branch) => branch.name === "my");

		expect(config.fork).toBe("codgician/proxmox-nixos");
		expect(config.upstream).toEqual({ repository: "SaumonNet/proxmox-nixos", branch: "main" });
		expect(my?.track).toEqual({ kind: "branch", branch: "main" });
		expect(my?.onConflict).toBe("ai");
		expect(my?.container).toBeUndefined();
	});

	test("rejects more than one tracking form", async () => {
		const path = await writeConfig(
			`${BASE}  my:\n    track:\n      branch: main\n      tags:\n        match: 'v.*'\n`,
		);
		expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("rejects duplicate branch contributions", async () => {
		const path = await writeConfig(
			`${BASE}  my:\n    track:\n      releases: {}\n    contributions:\n      - type: branch\n        name: topic\n      - type: branch\n        name: topic\n`,
		);
		await expect(loadConfig(path)).rejects.toThrow(/same contribution more than once/);
	});

	test("rejects duplicate pull-request contributions", async () => {
		const path = await writeConfig(
			`${BASE}  my:\n    track:\n      releases: {}\n    contributions:\n      - type: pr\n        number: 39512\n      - type: pr\n        number: 39512\n`,
		);
		await expect(loadConfig(path)).rejects.toThrow(/same contribution more than once/);
	});

	test("rejects malformed pull-request contributions", async () => {
		for (const contribution of [
			"      - type: pr\n",
			"      - type: pr\n        number: 0\n",
			"      - type: pr\n        number: 1.5\n",
			"      - type: pr\n        number: 9007199254740992\n",
			"      - type: pr\n        number: 39512\n        name: topic\n",
		]) {
			const path = await writeConfig(
				`${BASE}  my:\n    track:\n      releases: {}\n    contributions:\n${contribution}`,
			);
			await expect(loadConfig(path)).rejects.toThrow(ConfigError);
		}
	});

	test("rejects legacy untyped contributions", async () => {
		for (const contribution of ["      - topic\n", "      - pr: 39512\n"]) {
			const path = await writeConfig(
				`${BASE}  my:\n    track:\n      releases: {}\n    contributions:\n${contribution}`,
			);
			await expect(loadConfig(path)).rejects.toThrow(ConfigError);
		}
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
	test("finds every managed repository config", async () => {
		expect(await discoverConfigFiles(".")).toEqual([
			"repositories/codgician/coreboot/forkit.yaml",
			"repositories/codgician/litellm/forkit.yaml",
			"repositories/codgician/proxmox-nixos/forkit.yaml",
			"repositories/codgician/redrix-ec/forkit.yaml",
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
