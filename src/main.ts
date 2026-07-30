import { mkdir } from "node:fs/promises";
import { AiConflictResolver } from "./ai/resolver.ts";
import { discoverConfigFiles, loadConfig } from "./config/load.ts";
import type { RepoConfig } from "./config/types.ts";
import type { ConflictResolver } from "./engine/compose.ts";
import { type RepoReport, runRepository } from "./engine/run.ts";

/**
 * Entry point for the manage workflow.
 *
 * `--list` prints the discovered forks as JSON for a job matrix; otherwise the
 * named fork is run, or every one of them if none is named.
 */
async function main(): Promise<number> {
	const configPaths = await discoverConfigFiles(".");
	if (configPaths.length === 0) {
		console.error("No repositories/<owner>/<repo>/forkit.yaml found");
		return 1;
	}

	const args = process.argv.slice(2);
	const only = args.find((arg) => !arg.startsWith("--"));

	// Loading every config first means a typo in one fails the whole run before
	// any other fork is touched, rather than midway through.
	const configs: RepoConfig[] = [];
	for (const configPath of configPaths) {
		configs.push(await loadConfig(configPath));
	}

	const selected = only ? configs.filter((config) => config.fork === only) : configs;
	if (only && selected.length === 0) {
		console.error(`No managed repository named "${only}"`);
		return 1;
	}

	if (args.includes("--list")) {
		console.log(JSON.stringify(selected.map((config) => config.fork)));
		return 0;
	}

	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.error("GITHUB_TOKEN is required");
		return 1;
	}

	const dryRun = process.env.FORKIT_DRY_RUN === "1";

	// Without a key, conflicts fail the branch rather than silently going
	// unresolved; the engine treats a missing resolver as `on_conflict: fail`.
	const dendroKey = process.env.DENDRO_API_KEY;
	let resolver: ConflictResolver | undefined;
	if (dendroKey) {
		const trajectoryDirectory = process.env.FORKIT_TRAJECTORY_DIR ?? "trajectory";
		await mkdir(trajectoryDirectory, { recursive: true });
		resolver = new AiConflictResolver({ apiKey: dendroKey, trajectoryDirectory });
	} else {
		console.warn("DENDRO_API_KEY is unset: conflicts will fail instead of being resolved");
	}

	const reports: RepoReport[] = [];

	for (const config of selected) {
		console.log(`\n=== ${config.fork} ===`);
		try {
			const report = await runRepository(config, {
				token,
				sourceRepository: process.env.GITHUB_REPOSITORY ?? "codgician/forkit",
				dryRun,
				...(resolver ? { resolver } : {}),
			});
			reports.push(report);
			printReport(report);
		} catch (error) {
			console.error(`  fatal: ${(error as Error).message}`);
			reports.push({ repository: config.fork, branches: [], failed: true });
		}
	}

	await writeSummary(reports, dryRun);
	return reports.some((report) => report.failed) ? 1 : 0;
}

function printReport(report: RepoReport): void {
	for (const branch of report.branches) {
		console.log(`  branch ${branch.branch}: ${branch.status} — ${branch.detail}`);
		if (branch.image) console.log(`    image ${branch.image}`);
	}
}

/** Facts only: trajectory content must never reach a public run page. */
async function writeSummary(reports: RepoReport[], dryRun: boolean): Promise<void> {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (!path) return;

	const lines = [`# forkit${dryRun ? " (dry run)" : ""}`, ""];

	for (const report of reports) {
		lines.push(`## ${report.repository}`, "", "| branch | status | detail |", "| --- | --- | --- |");
		for (const branch of report.branches) {
			lines.push(`| \`${branch.branch}\` | ${branch.status} | ${branch.detail} |`);
		}
		lines.push("");

		for (const branch of report.branches) {
			if (branch.image) lines.push(`- \`${branch.image}\``);
		}
		lines.push("");
	}

	// Appended, not overwritten: matrix jobs share one summary.
	const existing = (await Bun.file(path).text().catch(() => "")) || "";
	await Bun.write(path, existing + lines.join("\n"));
}

process.exit(await main());
