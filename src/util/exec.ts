import { spawn } from "node:child_process";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Fail the returned promise on a non-zero exit. Default: true. */
	check?: boolean;
	stdin?: string;
	timeoutMs?: number;
}

export class CommandError extends Error {
	constructor(
		message: string,
		readonly result: RunResult,
		readonly argv: string[],
	) {
		super(message);
		this.name = "CommandError";
	}
}

/**
 * Execute argv directly. Never through a shell: forkit runs commands built from
 * configuration and upstream metadata, so there must be no interpolation into a
 * command line that a branch or tag name could escape.
 */
export function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
	const [command, ...args] = argv;
	if (!command) throw new Error("run() requires a command");

	const { check = true, timeoutMs = 15 * 60_000 } = options;

	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});

		if (options.stdin !== undefined) {
			child.stdin?.end(options.stdin);
		}

		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			const result: RunResult = { code: code ?? -1, stdout, stderr };

			if (timedOut) {
				reject(new CommandError(`${command} timed out after ${timeoutMs}ms`, result, argv));
				return;
			}
			if (check && result.code !== 0) {
				const detail = (stderr.trim() || stdout.trim()).split("\n").slice(-8).join("\n");
				reject(new CommandError(`${argv.join(" ")} exited ${result.code}\n${detail}`, result, argv));
				return;
			}
			resolve(result);
		});
	});
}
