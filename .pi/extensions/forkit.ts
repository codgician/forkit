import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default function forkitTasks(pi: ExtensionAPI): void {
	pi.registerCommand("forkit-plan", {
		description: "Plan managed repositories (optional FORKIT_REPOSITORY)",
		handler: task(async () => {
			const repository = process.env.FORKIT_REPOSITORY;
			await runForkit(["--plan", ...(repository ? ["--repository", repository] : [])]);
		}),
	});

	pi.registerCommand("forkit-compose", {
		description: "Compose FORKIT_REPOSITORY into source/",
		handler: task(async () => {
			await runForkit([
				"--compose",
				"--repository",
				requiredEnv("FORKIT_REPOSITORY"),
				"--artifact",
				"source",
			]);
		}),
	});

	pi.registerCommand("forkit-build", {
		description: "Build FORKIT_REPOSITORY for FORKIT_PLATFORM",
		handler: task(async () => {
			await runForkit([
				"--build",
				"--repository",
				requiredEnv("FORKIT_REPOSITORY"),
				"--artifact",
				"source",
				"--platform",
				requiredEnv("FORKIT_PLATFORM"),
			]);
		}),
	});

	pi.registerCommand("forkit-publish", {
		description: "Publish FORKIT_REPOSITORY from source/ and digests/",
		handler: task(async () => {
			await runForkit([
				"--publish",
				"--repository",
				requiredEnv("FORKIT_REPOSITORY"),
				"--artifact",
				"source",
				"--digests",
				"digests",
			]);
		}),
	});
}

function task(handler: () => Promise<void>): () => Promise<void> {
	return async () => {
		try {
			await handler();
		} catch (error) {
			process.exitCode = 1;
			throw error;
		}
	};
}

async function runForkit(args: string[]): Promise<void> {
	const child = spawn("bun", ["run", "src/main.ts", ...args], {
		cwd: ROOT,
		env: process.env,
		stdio: "inherit",
		shell: false,
	});

	const code = await new Promise<number>((resolveCode, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode, signal) => {
			if (exitCode === null) {
				reject(new Error(`forkit task terminated by ${signal ?? "an unknown signal"}`));
				return;
			}
			resolveCode(exitCode);
		});
	});

	if (code !== 0) throw new Error(`forkit task exited with code ${code}`);
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
