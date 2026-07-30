import { mkdir } from "node:fs/promises";
import { AiConflictResolver } from "./ai/resolver.ts";
import { discoverConfigFiles, loadConfig } from "./config/load.ts";
import type { ConflictResolver } from "./engine/compose.ts";
import { type RepoReport, runRepository } from "./engine/run.ts";

/**
 * Entry point for the manage workflow.
 *
 * Discovers every managed repository, runs each, and exits non-zero if any
 * failed. Repositories are independent: one failing must not prevent the others
 * from being updated.
 */
async function main(): Promise<number> {
	const dryRun = process.env.FORKIT_DRY_RUN === "1";
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.error("GITHUB_TOKEN is required");
		return 1;
	}

	const only = process.argv[2];
	const configPaths = await discoverConfigFiles(".");
	if (configPaths.length === 0) {
		console.error("No repositories/<owner>/<repo>/forkit.yaml found");
		return 1;
	}

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

	for (const configPath of configPaths) {
		const config = await loadConfig(configPath);
		if (only && config.fork !== only) continue;

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
			reports.push({ repository: config.fork, maintenance: [], branches: [], failed: true });
		}
	}

	await writeSummary(reports, dryRun);
	return reports.some((report) => report.failed) ? 1 : 0;
}

function printReport(report: RepoReport): void {
	for (const result of report.maintenance) {
		console.log(`  pr #${result.pullRequest} ${result.branch}: ${result.status} — ${result.detail}`);
	}
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
		lines.push(`## ${report.repository}`, "");

		if (report.maintenance.length > 0) {
			lines.push("| pull request | branch | status |", "| --- | --- | --- |");
			for (const result of report.maintenance) {
				lines.push(`| #${result.pullRequest} | \`${result.branch}\` | ${result.status} |`);
			}
			lines.push("");
		}

		lines.push("| branch | status | detail |", "| --- | --- | --- |");
		for (const branch of report.branches) {
			lines.push(`| \`${branch.branch}\` | ${branch.status} | ${branch.detail} |`);
		}
		lines.push("");

		for (const branch of report.branches) {
			if (branch.image) lines.push(`- \`${branch.image}\``);
		}
		lines.push("");
	}

	await Bun.write(path, lines.join("\n"));
}

process.exit(await main());
