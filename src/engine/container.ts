import type { ContainerSpec } from "../config/types.ts";
import { toOciTag } from "../config/types.ts";
import { run } from "../util/exec.ts";
import type { ComposedBranch } from "./compose.ts";

export interface PublishOptions {
	container: ContainerSpec;
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
	const { container } = options;
	const immutable = `${container.image}:${toOciTag(
		`${composed.source.ref}-${composed.branch}.${composed.commit.slice(0, 8)}`,
	)}`;
	const moving = `${container.image}:${toOciTag(composed.branch)}`;

	await run(
		[
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
			container.dockerfile,
			options.worktree,
		],
		{ cwd: options.worktree, timeoutMs: 60 * 60_000 },
	);

	await smokeTest(immutable, container.smoke);

	if (options.dryRun) return { immutable, moving, digest: undefined };

	await run(["docker", "push", immutable]);
	await run(["docker", "push", moving]);

	const inspected = await run(
		["docker", "inspect", "--format", "{{index .RepoDigests 0}}", immutable],
		{ check: false },
	);

	return {
		immutable,
		moving,
		digest: inspected.code === 0 ? inspected.stdout.trim() : undefined,
	};
}

/**
 * Confirm the image runs.
 *
 * The command is per repository because only the project knows what proves its
 * image works. A build alone catches a broken Dockerfile; this catches an image
 * that builds but cannot start, which is what a bad conflict resolution most
 * often produces.
 */
async function smokeTest(image: string, smoke: ContainerSpec["smoke"]): Promise<void> {
	if (!smoke) return;

	const result = await run(
		[
			"docker",
			"run",
			"--rm",
			...(smoke.entrypoint ? ["--entrypoint", smoke.entrypoint] : []),
			image,
			...smoke.command,
		],
		{ check: false, timeoutMs: 5 * 60_000 },
	);

	if (result.code !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-15).join("\n");
		throw new Error(`Smoke test failed for ${image}:\n${detail}`);
	}
}
