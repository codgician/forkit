import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/exec.ts";

export interface TrajectoryEvent {
	at: string;
	type: string;
	[key: string]: unknown;
}

/**
 * Records what the resolver did, for tuning the harness.
 *
 * This is development telemetry, not provenance: the durable record of a
 * resolution is its commit message. Nothing here is written to stdout or the
 * job summary, because those are public on a public repository and the archive
 * is encrypted precisely so the detail is not.
 */
export class Trajectory {
	private readonly events: TrajectoryEvent[] = [];
	private readonly startedAt = Date.now();

	constructor(
		readonly name: string,
		private readonly directory: string,
	) {}

	record(type: string, fields: Record<string, unknown> = {}): void {
		this.events.push({ at: new Date().toISOString(), type, ...fields });
	}

	/**
	 * Write the transcript and encrypt it.
	 *
	 * AES-256 with encrypted headers: `zip -e` uses ZipCrypto, which is broken
	 * under known-plaintext attack, and these transcripts are highly predictable
	 * JSON. Header encryption matters too, since a filename like
	 * "conflict-authenticator.py-gate-failed" leaks the interesting part on its
	 * own.
	 */
	async persist(summary: TrajectorySummary): Promise<string | undefined> {
		const password = process.env.TRAJECTORY_ZIP_PASSWD;
		const staging = join(this.directory, this.name);
		await mkdir(staging, { recursive: true });

		await Bun.write(join(staging, "summary.md"), renderSummary(summary, this.events, this.startedAt));
		await Bun.write(
			join(staging, "events.jsonl"),
			`${this.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		);

		if (!password) return staging;

		const archive = join(this.directory, `${this.name}.7z`);
		await run(["7z", "a", "-t7z", `-p${password}`, "-mhe=on", "-mx=6", archive, staging], {
			timeoutMs: 120_000,
		});
		await rm(staging, { recursive: true, force: true });

		return archive;
	}
}

export interface TrajectorySummary {
	description: string;
	conflictedPaths: string[];
	model: string;
	thinkingLevel: string;
	outcome: string;
	gateFailures?: string[];
}

function renderSummary(
	summary: TrajectorySummary,
	events: TrajectoryEvent[],
	startedAt: number,
): string {
	const toolCalls = events.filter((event) => event.type === "tool_execution_end");
	const usage = events.findLast((event) => event.type === "usage");

	const lines = [
		`# ${summary.description}`,
		"",
		`- outcome: ${summary.outcome}`,
		`- model: ${summary.model} (thinking: ${summary.thinkingLevel})`,
		`- conflicted: ${summary.conflictedPaths.join(", ")}`,
		`- duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
		`- tool calls: ${toolCalls.length}`,
	];

	if (usage) {
		// Reasoning tokens are the only way to tell whether the requested
		// thinking level survived the proxy, so they are called out explicitly.
		lines.push(`- tokens: ${JSON.stringify(usage.usage)}`);
	}
	if (summary.gateFailures?.length) {
		lines.push("", "## Gate failures", ...summary.gateFailures.map((failure) => `- ${failure}`));
	}

	lines.push("", "## Tool calls", "");
	for (const call of toolCalls) {
		lines.push(`- \`${call.toolName}\` ${JSON.stringify(call.args ?? {}).slice(0, 200)}`);
	}

	lines.push("", "## Assistant output", "");
	for (const event of events.filter((event) => event.type === "assistant_text")) {
		lines.push(String(event.text));
	}

	return lines.join("\n");
}
