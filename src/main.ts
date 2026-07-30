import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { AiConflictResolver } from "./ai/resolver.ts";
import { discoverConfigFiles, loadConfig } from "./config/load.ts";
import type { RepoConfig } from "./config/types.ts";
import type { ConflictResolver } from "./engine/compose.ts";
import {
	buildArtifactPlatform,
	createRepositoryArtifact,
	publishRepositoryArtifact,
	type RepositoryArtifact,
} from "./engine/artifact.ts";

/**
 * Workflow entry point.
 *
 * Compose runs once per fork. Native architecture jobs then build the exact
 * bundled commit, and publish names their digests as one manifest before moving
 * the branch.
 */
async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const configs = await loadAllConfigs();
	const repository = valueOf(args, "--repository");
	const selected = repository ? configs.filter((config) => config.fork === repository) : configs;

	if (repository && selected.length === 0) {
		console.error(`No managed repository named "${repository}"`);
		return 1;
	}

	if (args.includes("--plan")) {
		console.log(JSON.stringify(makePlan(selected)));
		return 0;
	}

	const artifactDirectory = resolve(valueOf(args, "--artifact") ?? "forkit-artifact");
	const platform = valueOf(args, "--platform");
	const dryRun = process.env.FORKIT_DRY_RUN === "1";

	if (args.includes("--compose")) {
		const token = requiredToken();
		const config = requireOne(selected, "compose");
		const resolver = await createResolver(platform);
		const artifact = await createRepositoryArtifact(config, token, resolver, artifactDirectory);
		for (const branch of artifact.branches) {
			console.log(`branch ${branch.name}: ${branch.changed ? "changed" : "unchanged"} ${branch.commit.slice(0, 8)}`);
		}
		await writeComposeOutputs(artifact);
		return 0;
	}

	if (args.includes("--build")) {
		if (!platform) throw new Error("--build requires --platform");
		const pairs = await buildArtifactPlatform(
			artifactDirectory,
			platform,
			process.env.GITHUB_REPOSITORY ?? "codgician/forkit",
			dryRun,
		);
		const output = process.env.FORKIT_DIGEST_FILE;
		if (output) await Bun.write(output, pairs.length ? `${pairs.join("\n")}\n` : "");
		for (const pair of pairs) console.log(`digest ${pair}`);
		return 0;
	}

	if (args.includes("--publish")) {
		const token = requiredToken();
		const digests = await readDigests(valueOf(args, "--digests") ?? "digests");
		const results = await publishRepositoryArtifact(artifactDirectory, digests, token, dryRun);
		for (const result of results) {
			console.log(`branch ${result.branch}: ${result.status}${result.image ? ` ${result.image}` : ""}`);
		}
		return 0;
	}

	console.error("Expected one of --plan, --compose, --build, --publish");
	return 1;
}

async function loadAllConfigs(): Promise<RepoConfig[]> {
	const paths = await discoverConfigFiles(".");
	if (paths.length === 0) throw new Error("No repositories/<owner>/<repo>/forkit.yaml found");

	const configs: RepoConfig[] = [];
	for (const path of paths) configs.push(await loadConfig(path));
	return configs;
}

async function writeComposeOutputs(artifact: RepositoryArtifact): Promise<void> {
	const path = process.env.GITHUB_OUTPUT;
	if (!path) return;

	const platforms = [
		...new Set(
			artifact.branches
				.filter((branch) => branch.changed)
				.flatMap((branch) => branch.container?.platforms ?? []),
		),
	];
	const builds = platforms.map((platform) => ({ platform, runner: runnerFor(platform) }));
	const changed = artifact.branches.some((branch) => branch.changed);
	const existing = (await Bun.file(path).text().catch(() => "")) || "";
	await Bun.write(
		path,
		`${existing}builds=${JSON.stringify(builds)}\nchanged=${changed}\n`,
	);
}

function requireOne(configs: RepoConfig[], operation: string): RepoConfig {
	if (configs.length !== 1) {
		throw new Error(`--${operation} requires exactly one --repository`);
	}
	return configs[0]!;
}

function requiredToken(): string {
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is required for this operation");
	return token;
}

function makePlan(configs: RepoConfig[]): {
	repositories: { repository: string; artifact: string }[];
	builds: { repository: string; artifact: string; platform: string; runner: string }[];
} {
	const repositories = configs.map((config, index) => ({
		repository: config.fork,
		artifact: `source-${index}`,
	}));
	const builds = repositories.flatMap((entry) => {
		const config = configs.find((candidate) => candidate.fork === entry.repository)!;
		const platforms = [
			...new Set(config.branches.flatMap((branch) => branch.container?.platforms ?? [])),
		];
		return platforms.map((platform) => ({
			...entry,
			platform,
			runner: runnerFor(platform),
		}));
	});
	return { repositories, builds };
}

function runnerFor(platform: string): string {
	if (platform === "linux/amd64") return "ubuntu-24.04";
	if (platform === "linux/arm64") return "ubuntu-24.04-arm";
	throw new Error(`No native GitHub runner configured for ${platform}`);
}

async function createResolver(platform: string | undefined): Promise<ConflictResolver | undefined> {
	if (platform) return undefined;
	const key = process.env.DENDRO_API_KEY;
	if (!key) {
		console.warn("DENDRO_API_KEY is unset: conflicts will fail instead of being resolved");
		return undefined;
	}

	const directory = process.env.FORKIT_TRAJECTORY_DIR ?? "trajectory";
	await mkdir(directory, { recursive: true });
	return new AiConflictResolver({ apiKey: key, trajectoryDirectory: directory });
}

async function readDigests(directory: string): Promise<Record<string, string[]>> {
	const glob = new Bun.Glob("**/*.txt");
	const byBranch: Record<string, string[]> = {};
	for await (const path of glob.scan({ cwd: directory, absolute: true })) {
		for (const entry of (await Bun.file(path).text()).split(/\s+/).filter(Boolean)) {
			const [key, digest] = entry.split("=");
			if (key && digest) (byBranch[key] ??= []).push(digest);
		}
	}
	return byBranch;
}

function valueOf(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

process.exit(await main());
