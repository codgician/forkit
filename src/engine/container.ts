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
	platforms: string[];
	digest: string | undefined;
}

/**
 * Build and publish a composed branch as a single multi-platform image.
 *
 * Every platform lives under one tag as an OCI manifest list, so an
 * architecture never appears in the image name and a client pulls whichever
 * matches it.
 *
 * Buildx assembles a manifest list in the registry, not in the local daemon,
 * so the immutable tag is pushed as part of the build rather than after it. It
 * is still pushed and verified before the moving tag advances.
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

	const labels = [
		// Links the package to the publishing repository, which is what grants
		// its workflow permission to push.
		`org.opencontainers.image.source=https://github.com/${options.sourceRepository}`,
		`org.opencontainers.image.revision=${composed.commit}`,
		`org.opencontainers.image.version=${composed.source.ref}`,
		`forkit.contributions=${composed.applied.join(",")}`,
	];

	await run(
		[
			"docker",
			"buildx",
			"build",
			"--platform",
			container.platforms.join(","),
			"--file",
			container.dockerfile,
			...labels.flatMap((label) => ["--label", label]),
			"--tag",
			immutable,
			// A dry run cannot load a manifest list into the daemon, so it builds
			// every platform and discards the result; the point is proving each one
			// compiles.
			options.dryRun ? "--output=type=cacheonly" : "--push",
			options.worktree,
		],
		{ cwd: options.worktree, timeoutMs: 3 * 60 * 60_000 },
	);

	if (options.dryRun) {
		return { immutable, moving, platforms: container.platforms, digest: undefined };
	}

	await verifyPlatforms(immutable, container.platforms);
	await smokeTest(immutable, container.smoke);

	// Retagging by manifest keeps the moving tag pointing at the same digest
	// rather than rebuilding, so both tags are byte-identical.
	await run(["docker", "buildx", "imagetools", "create", "--tag", moving, immutable]);

	const inspected = await run(["docker", "buildx", "imagetools", "inspect", immutable], {
		check: false,
	});
	const digest = /Digest:\s*(sha256:[0-9a-f]+)/.exec(inspected.stdout)?.[1];

	return { immutable, moving, platforms: container.platforms, digest };
}

/**
 * Confirm the manifest list actually contains every requested platform.
 *
 * Buildx can succeed while silently producing fewer entries than asked for, and
 * a missing architecture would only surface as a pull failure on that machine.
 */
async function verifyPlatforms(image: string, expected: string[]): Promise<void> {
	const { stdout } = await run([
		"docker",
		"buildx",
		"imagetools",
		"inspect",
		"--format",
		"{{json .Manifest}}",
		image,
	]);

	const present = [...stdout.matchAll(/"architecture":\s*"([^"]+)"[^}]*"os":\s*"([^"]+)"/g)].map(
		([, architecture, os]) => `${os}/${architecture}`,
	);

	const missing = expected.filter(
		(platform) => !present.includes(platform.split("/").slice(0, 2).join("/")),
	);
	if (missing.length > 0) {
		throw new Error(
			`${image} is missing ${missing.join(", ")}; manifest has ${present.join(", ") || "nothing"}`,
		);
	}
}

/**
 * Confirm the image runs.
 *
 * Only the runner's own architecture is exercised: running another would need
 * emulation, and a cross-architecture failure is a base image problem rather
 * than something a contribution causes.
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
		{ check: false, timeoutMs: 10 * 60_000 },
	);

	if (result.code !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-15).join("\n");
		throw new Error(`Smoke test failed for ${image}:\n${detail}`);
	}
}
