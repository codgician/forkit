import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BranchRule, ContainerSpec, RepoConfig } from "../config/types.ts";
import { Git } from "../git/git.ts";
import type { ConflictResolver, ComposedBranch } from "./compose.ts";
import { composeBranch } from "./compose.ts";
import { buildPlatform, mergeManifest, smokeTest, tagFor } from "./container.ts";
import { GitHub } from "../github/client.ts";
import { run } from "../util/exec.ts";
import { FORK_REMOTE, UPSTREAM_REMOTE, Workspace } from "./workspace.ts";

export interface ArtifactBranch {
	name: string;
	/** Present when this branch has synthetic commits beyond its upstream source. */
	ref?: string;
	/** Source archive consumed by native builders. */
	archive?: string;
	source: { ref: string; fetchSpec: string; kind: "branch" | "releases" | "tags" };
	sourceCommit: string;
	commit: string;
	applied: string[];
	skipped: { branch: string; reason: string }[];
	previous?: string;
	changed: boolean;
	container?: ContainerSpec;
}

export interface RepositoryArtifact {
	repository: string;
	upstreamRepository: string;
	branches: ArtifactBranch[];
}

/**
 * Compose every branch exactly once and preserve its exact source.
 *
 * A full Git bundle of litellm is ~841 MB. The artifact instead contains:
 *
 * - one compressed tree archive per changed container branch (~52 MB), used by
 *   native builders;
 * - one incremental bundle of synthetic commits (~28 KB), with the upstream
 *   release declared as a prerequisite, used by the publisher.
 */
export async function createRepositoryArtifact(
	config: RepoConfig,
	token: string,
	resolver: ConflictResolver | undefined,
	directory: string,
): Promise<RepositoryArtifact> {
	await mkdir(join(directory, "sources"), { recursive: true });

	const github = new GitHub(token);
	const [snapshot, committer] = await Promise.all([
		github.snapshot(config.upstream.repository, config.fork),
		github.viewer(),
	]);
	const workspace = await Workspace.create({
		forkRepository: config.fork,
		upstreamRepository: config.upstream.repository,
		token,
		committer,
	});

	try {
		await workspace.fetch(UPSTREAM_REMOTE, [
			`+refs/heads/${config.upstream.branch}:refs/remotes/upstream/${config.upstream.branch}`,
		]);
		await workspace.fetch(
			FORK_REMOTE,
			[...new Set(config.branches.flatMap((rule) => rule.contributions))].map(
				(branch) => `+refs/heads/${branch}:refs/remotes/${FORK_REMOTE}/${branch}`,
			),
		);
		await workspace.fetch(
			UPSTREAM_REMOTE,
			[...new Set(snapshot.openPullRequests.map((pull) => pull.baseRef))].map(
				(ref) => `+refs/heads/${ref}:refs/remotes/upstream/${ref}`,
			),
		);

		const branches: ArtifactBranch[] = [];
		for (const rule of config.branches) {
			const composed = await composeBranch(rule, config, workspace.git, snapshot, github, resolver);
			const encoded = Buffer.from(rule.name).toString("hex");
			const ref = composed.commit !== composed.sourceCommit
				? `refs/forkit/outputs/${encoded}`
				: undefined;
			if (ref) await workspace.git.updateRef(ref, composed.commit);

			const archive = rule.container && composed.changed ? `sources/${encoded}.tar.gz` : undefined;
			if (archive) {
				await workspace.git.git([
					"archive",
					"--format=tar.gz",
					`--output=${join(directory, archive)}`,
					composed.commit,
				]);
			}
			branches.push(serialize(rule, composed, ref, archive));
		}

		const synthetic = branches.filter((branch) => branch.ref);
		if (synthetic.length > 0) {
			const prerequisites = [...new Set(synthetic.map((branch) => branch.sourceCommit))];
			await workspace.git.createBundle(
				join(directory, "commits.bundle"),
				[
					...synthetic.map((branch) => branch.ref!),
					...prerequisites.map((commit) => `^${commit}`),
				],
			);
		}

		const artifact: RepositoryArtifact = {
			repository: config.fork,
			upstreamRepository: config.upstream.repository,
			branches,
		};
		await Bun.write(join(directory, "metadata.json"), `${JSON.stringify(artifact, null, 2)}\n`);
		return artifact;
	} finally {
		await workspace.dispose();
	}
}

/** Build every changed container branch supporting this native platform. */
export async function buildArtifactPlatform(
	directory: string,
	platform: string,
	sourceRepository: string,
	dryRun: boolean,
): Promise<string[]> {
	const artifact = await readArtifact(directory);
	const pairs: string[] = [];

	for (const branch of artifact.branches) {
		if (!branch.changed || !branch.container || !branch.container.platforms.includes(platform)) continue;
		if (!branch.archive) throw new Error(`No source archive for ${branch.name}`);

		const worktree = join(directory, `work-${Buffer.from(branch.name).toString("hex")}`);
		await mkdir(worktree, { recursive: true });
		await run(["tar", "-xzf", join(directory, branch.archive), "-C", worktree]);

		const digest = await buildPlatform(deserialize(branch, worktree), {
			container: branch.container,
			platform,
			worktree,
			sourceRepository,
			dryRun,
		});
		if (digest) pairs.push(`${artifact.repository}|${branch.name}=${digest}`);
	}

	return pairs;
}

/**
 * Name all platform digests as one manifest list, then advance the exact
 * bundled commits with lease protection.
 */
export async function publishRepositoryArtifact(
	directory: string,
	digests: Record<string, string[]>,
	token: string,
	dryRun: boolean,
): Promise<{ branch: string; status: string; image?: string }[]> {
	const artifact = await readArtifact(directory);
	const results: { branch: string; status: string; image?: string }[] = [];
	const git = new Git(directory);
	await git.git(["init", "--quiet"]);
	await git.addRemote(UPSTREAM_REMOTE, `https://github.com/${artifact.upstreamRepository}.git`);
	await git.addRemote(FORK_REMOTE, `https://x-access-token:${token}@github.com/${artifact.repository}.git`);

	// Fetch exact prerequisite commits before importing the incremental bundle.
	for (const branch of artifact.branches) {
		await git.fetch(UPSTREAM_REMOTE, [
			`+${branch.sourceCommit}:refs/forkit/sources/${branch.sourceCommit}`,
		]);
	}
	const bundle = join(directory, "commits.bundle");
	if (await Bun.file(bundle).exists()) {
		for (const branch of artifact.branches.filter((candidate) => candidate.ref)) {
			await git.git(["fetch", bundle, `${branch.ref!}:${branch.ref!}`]);
		}
	}

	for (const branch of artifact.branches) {
		if (!branch.changed) {
			results.push({ branch: branch.name, status: "unchanged" });
			continue;
		}

		let image: string | undefined;
		if (branch.container) {
			const key = `${artifact.repository}|${branch.name}`;
			const platformDigests = digests[key] ?? [];
			if (platformDigests.length !== branch.container.platforms.length) {
				throw new Error(`${key} has ${platformDigests.length} digest(s), expected ${branch.container.platforms.length}`);
			}

			const tags = tagFor(deserialize(branch, directory), branch.container);
			if (!dryRun) {
				await mergeManifest(tags.immutable, branch.container.image, platformDigests);
				await smokeTest(tags.immutable, branch.container.smoke);
				await mergeManifest(tags.moving, branch.container.image, platformDigests);
			}
			image = tags.immutable;
		}

		if (!dryRun) await git.pushWithLease(FORK_REMOTE, branch.name, branch.commit, branch.previous);
		results.push({ branch: branch.name, status: "updated", ...(image ? { image } : {}) });
	}

	return results;
}

export async function readArtifact(directory: string): Promise<RepositoryArtifact> {
	return (await Bun.file(join(directory, "metadata.json")).json()) as RepositoryArtifact;
}

function serialize(
	rule: BranchRule,
	composed: ComposedBranch,
	ref: string | undefined,
	archive: string | undefined,
): ArtifactBranch {
	return {
		name: rule.name,
		...(ref ? { ref } : {}),
		...(archive ? { archive } : {}),
		source: composed.source,
		sourceCommit: composed.sourceCommit,
		commit: composed.commit,
		applied: composed.applied,
		skipped: composed.skipped,
		...(composed.previous ? { previous: composed.previous } : {}),
		changed: composed.changed,
		...(rule.container ? { container: rule.container } : {}),
	};
}

function deserialize(branch: ArtifactBranch, worktree: string): ComposedBranch {
	return {
		branch: branch.name,
		source: branch.source,
		sourceCommit: branch.sourceCommit,
		commit: branch.commit,
		applied: branch.applied,
		skipped: branch.skipped,
		previous: branch.previous,
		changed: branch.changed,
		worktree,
	};
}
