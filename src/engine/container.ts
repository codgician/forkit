import { toOciTag } from "../config/types.ts";
import { run } from "../util/exec.ts";
import type { ComposedBranch } from "./compose.ts";

export interface PublishOptions {
	image: string;
	worktree: string;
	/** Repository that owns the workflow, for the source label. */
	sourceRepository: string;
	dryRun: boolean;
}

export interface PublishResult {
	/** Never-reused tag identifying exactly this tree. */
	immutable: string;
	/** Branch-named tag repointed at this build. */
	moving: string;
	digest: string | undefined;
}

/**
 * Build and publish a composed branch.
 *
 * Order matters: the immutable tag is pushed and verified before the branch or
 * the moving tag moves, so a branch can never point at a build that was not
 * successfully published.
 */
export async function publishContainer(
	composed: ComposedBranch,
	options: PublishOptions,
): Promise<PublishResult> {
	const branchTag = toOciTag(composed.branch);
	const immutable = `${options.image}:${toOciTag(`${composed.source.ref}-${composed.branch}.${composed.commit.slice(0, 8)}`)}`;
	const moving = `${options.image}:${branchTag}`;

	await run([
		"docker",
		"build",
		"--tag",
		immutable,
		"--tag",
		moving,
		// Links the package to the publishing repository, which is what grants
		// GITHUB_TOKEN permission to push to it.
		"--label",
		`org.opencontainers.image.source=https://github.com/${options.sourceRepository}`,
		"--label",
		`org.opencontainers.image.revision=${composed.commit}`,
		"--label",
		`org.opencontainers.image.version=${composed.source.ref}`,
		"--label",
		`forkit.contributions=${composed.applied.join(",")}`,
		"--file",
		"Dockerfile",
		options.worktree,
	], { cwd: options.worktree, timeoutMs: 60 * 60_000 });

	await smokeTest(immutable);

	if (options.dryRun) return { immutable, moving, digest: undefined };

	await run(["docker", "push", immutable]);
	await run(["docker", "push", moving]);

	const inspected = await run([
		"docker",
		"inspect",
		"--format",
		"{{index .RepoDigests 0}}",
		immutable,
	], { check: false });

	return {
		immutable,
		moving,
		digest: inspected.code === 0 ? inspected.stdout.trim() : undefined,
	};
}

/**
 * Confirm the image starts.
 *
 * Deliberately minimal for now: it catches a build that produces an unusable
 * entrypoint or an import error from a bad resolution, which is the failure a
 * conflict is most likely to cause. It does not exercise the database.
 */
async function smokeTest(image: string): Promise<void> {
	const result = await run(["docker", "run", "--rm", "--entrypoint", "litellm", image, "--version"], {
		check: false,
		timeoutMs: 5 * 60_000,
	});

	if (result.code !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-15).join("\n");
		throw new Error(`Smoke test failed for ${image}:\n${detail}`);
	}
}
