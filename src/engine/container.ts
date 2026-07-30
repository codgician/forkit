import type { ContainerSpec } from "../config/types.ts";
import { toOciTag } from "../config/types.ts";
import { run } from "../util/exec.ts";
import type { ComposedBranch } from "./compose.ts";

export interface BuildOptions {
	container: ContainerSpec;
	/** Single platform this runner builds natively, e.g. linux/arm64. */
	platform: string;
	worktree: string;
	/** Repository that owns the workflow, for the source label. */
	sourceRepository: string;
	dryRun: boolean;
}

export interface Tags {
	/** Never-reused tag identifying exactly this tree. */
	immutable: string;
	/** Branch-named tag repointed at this build. */
	moving: string;
}

export function tagFor(composed: ComposedBranch, container: ContainerSpec): Tags {
	return {
		immutable: `${container.image}:${toOciTag(
			`${composed.source.ref}-${composed.branch}.${composed.commit.slice(0, 8)}`,
		)}`,
		moving: `${container.image}:${toOciTag(composed.branch)}`,
	};
}

/**
 * Build one platform on a runner of that architecture and push it by digest.
 *
 * Each architecture is built natively rather than emulated: the litellm builder
 * stage compiles native wheels and runs prisma, which under QEMU costs roughly
 * an order of magnitude more time than the whole native build.
 *
 * The result is pushed unnamed, by digest, so no tag ever refers to a single
 * architecture. The merge step is what gives these digests a name.
 */
export async function buildPlatform(
	composed: ComposedBranch,
	options: BuildOptions,
): Promise<string | undefined> {
	const { container, platform } = options;

	const labels = [
		// Links the package to the publishing repository, which is what grants
		// its workflow permission to push.
		`org.opencontainers.image.source=https://github.com/${options.sourceRepository}`,
		`org.opencontainers.image.revision=${composed.commit}`,
		`org.opencontainers.image.version=${composed.source.ref}`,
		`forkit.contributions=${composed.applied.join(",")}`,
	];

	const output = options.dryRun
		? "type=cacheonly"
		: `type=image,name=${container.image},push-by-digest=true,name-canonical=true,push=true`;

	const result = await run(
		[
			"docker",
			"buildx",
			"build",
			"--platform",
			platform,
			"--file",
			container.dockerfile,
			...labels.flatMap((label) => ["--label", label]),
			"--metadata-file",
			"/tmp/forkit-build.json",
			`--output=${output}`,
			options.worktree,
		],
		{ cwd: options.worktree, timeoutMs: 3 * 60 * 60_000 },
	);

	if (options.dryRun) return undefined;

	const metadata = await Bun.file("/tmp/forkit-build.json")
		.json()
		.catch(() => ({}) as Record<string, unknown>);
	const digest = metadata["containerimage.digest"];

	if (typeof digest !== "string") {
		throw new Error(
			`Build of ${platform} reported no digest\n${result.stderr.trim().split("\n").slice(-10).join("\n")}`,
		);
	}
	return digest;
}

/**
 * Point a tag at every platform digest as one OCI manifest list.
 *
 * A tag therefore means the same build on every architecture, and a client
 * pulls whichever entry matches it.
 */
export async function mergeManifest(
	tag: string,
	image: string,
	digests: string[],
): Promise<void> {
	await run([
		"docker",
		"buildx",
		"imagetools",
		"create",
		"--tag",
		tag,
		...digests.map((digest) => `${image}@${digest}`),
	]);

	await verifyManifest(tag, digests.length);
}

/**
 * Confirm the manifest carries as many platforms as were built.
 *
 * imagetools can succeed while producing fewer entries than asked for, and a
 * missing architecture would only surface as a pull failure on that machine.
 */
async function verifyManifest(tag: string, expected: number): Promise<void> {
	const { stdout } = await run([
		"docker",
		"buildx",
		"imagetools",
		"inspect",
		"--format",
		"{{json .Manifest}}",
		tag,
	]);

	const platforms = [
		...stdout.matchAll(/"architecture":\s*"([^"]+)"[^}]*?"os":\s*"([^"]+)"/g),
	].map(([, architecture, os]) => `${os}/${architecture}`);

	if (platforms.length < expected) {
		throw new Error(
			`${tag} has ${platforms.length} platform(s) (${platforms.join(", ") || "none"}), expected ${expected}`,
		);
	}
}

/**
 * Confirm the image runs.
 *
 * Only the runner's own architecture is exercised. Running another would need
 * emulation, and a cross-architecture failure is a base image problem rather
 * than something a contribution causes.
 */
export async function smokeTest(image: string, smoke: ContainerSpec["smoke"]): Promise<void> {
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

