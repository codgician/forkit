import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchRule, RepoConfig } from "../config/types.ts";
import type { Git } from "../git/git.ts";
import { run } from "../util/exec.ts";
import type { ComposedBranch } from "./compose.ts";

/** Build/test an exported tree; host adaptations cannot alter published code. */
export async function validateBranch(rule: BranchRule, config: RepoConfig, composed: ComposedBranch, git: Git): Promise<void> {
	if (!rule.validation) return;
	const directory = await mkdtemp(join(tmpdir(), "forkit-validation-"));
	try {
		const source = join(directory, "source");
		await mkdir(source);
		await git.git(["archive", "--format=tar", `--output=${join(directory, "source.tar")}`, composed.commit]);
		await run(["tar", "-xf", join(directory, "source.tar"), "-C", source]);
		// Do not pass publisher/resolver credentials to repository build tools.
		const env: Record<string, string> = {};
		for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE", "NIX_PROFILES", "NIX_PATH", "NIX_REMOTE"]) {
			if (process.env[key]) env[key] = process.env[key]!;
		}
		Object.assign(env, {
			FORKIT_CONFIG_DIR: config.configDir,
			FORKIT_REPOSITORY: config.fork,
			FORKIT_BRANCH: rule.name,
			FORKIT_COMMIT: composed.commit,
			FORKIT_SOURCE_COMMIT: composed.sourceCommit,
		});
		const result = await run(rule.validation.command, {
			cwd: source, env, inheritEnv: false,
			timeoutMs: rule.validation.timeout_minutes * 60_000,
		});
		console.log(`validation ${rule.name}: passed\n${result.stdout.trim()}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
