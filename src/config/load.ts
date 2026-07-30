import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { RepoConfigFile } from "./schema.ts";
import { type BranchRule, type RepoConfig, type TrackSpec, toOciTag } from "./types.ts";

export class ConfigError extends Error {
	constructor(message: string, readonly configPath: string) {
		super(`${configPath}: ${message}`);
		this.name = "ConfigError";
	}
}

/** Find every repositories/<owner>/<repo>/forkit.yaml beneath `root`. */
export async function discoverConfigFiles(root: string): Promise<string[]> {
	const base = join(root, "repositories");
	const found: string[] = [];

	let owners: string[];
	try {
		owners = (await readdir(base, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}

	for (const owner of owners) {
		const ownerDir = join(base, owner);
		const repos = (await readdir(ownerDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);

		for (const repo of repos) {
			const candidate = join(ownerDir, repo, "forkit.yaml");
			if (await Bun.file(candidate).exists()) found.push(candidate);
		}
	}

	return found.sort();
}

export async function loadConfig(configPath: string): Promise<RepoConfig> {
	const text = await Bun.file(configPath).text();

	let document: unknown;
	try {
		document = Bun.YAML.parse(text);
	} catch (error) {
		throw new ConfigError(`invalid YAML: ${(error as Error).message}`, configPath);
	}

	const parsed = RepoConfigFile.safeParse(document);
	if (!parsed.success) {
		throw new ConfigError(z.prettifyError(parsed.error), configPath);
	}
	const file = parsed.data;

	const branches = Object.entries(file.branches).map(([name, rule]): BranchRule => ({
		name,
		track: resolveTrack(rule.track, file.upstream.branch),
		contributions: rule.contributions,
		onConflict: rule.on_conflict,
		...(rule.container ? { container: rule.container } : {}),
	}));

	assertNoTagCollision(branches, configPath);

	return {
		fork: file.fork,
		upstream: file.upstream,
		branches,
		configDir: dirname(resolve(configPath)),
	};
}

function resolveTrack(track: RepoConfigFile["branches"][string]["track"], upstreamBranch: string): TrackSpec {
	if ("branch" in track) {
		// `upstream` is shorthand for the configured development branch.
		return { kind: "branch", branch: track.branch === "upstream" ? upstreamBranch : track.branch };
	}

	if ("tags" in track) {
		return { kind: "tags", match: new RegExp(track.tags.match) };
	}

	const { prerelease, match } = track.releases;
	return {
		kind: "releases",
		prerelease: prerelease === "any" ? "any" : prerelease ? "only" : "exclude",
		...(match ? { match: new RegExp(match) } : {}),
	};
}

/**
 * Two branches publishing to one image must not normalise to the same moving
 * tag, or each run would silently overwrite the other's.
 */
function assertNoTagCollision(branches: BranchRule[], configPath: string): void {
	const claimedBy = new Map<string, string>();

	for (const branch of branches) {
		if (!branch.container) continue;

		const tag = `${branch.container.image}:${toOciTag(branch.name)}`;
		const existing = claimedBy.get(tag);
		if (existing) {
			throw new ConfigError(
				`branches "${existing}" and "${branch.name}" both publish ${tag}`,
				configPath,
			);
		}
		claimedBy.set(tag, branch.name);
	}
}
