import { isSeq, parseDocument } from "yaml";
import { contributionIdentity, contributionSpec, upstreamIdentity } from "./types.ts";
import type { RepositoryArtifact } from "../engine/artifact.ts";
import { GitHubError, type GitHub } from "../github/client.ts";
import { RepoConfigFile } from "./schema.ts";

export function hasConfigCleanup(artifact: RepositoryArtifact): boolean {
	return artifact.branches.some((branch) => branch.skipped.length > 0);
}

/** Remove only the contributions proved shipped for each individual target. */
export function cleanedConfig(artifact: RepositoryArtifact): string | undefined {
	if (!hasConfigCleanup(artifact)) return undefined;
	if (!artifact.config) throw new Error("Artifact has no manifest snapshot; compose again before cleanup");
	const document = parseDocument(artifact.config.content);
	if (document.errors.length) throw new Error(`Invalid manifest: ${document.errors[0]!.message}`);
	const config = RepoConfigFile.parse(document.toJS());
	if (config.fork !== artifact.repository || upstreamIdentity(config.upstream) !== artifact.upstreamRepository) {
		throw new Error("Artifact manifest does not match its repositories");
	}

	for (const branch of artifact.branches) {
		if (branch.skipped.length === 0) continue;
		const contributions = document.getIn(["branches", branch.name, "contributions"]);
		if (!isSeq(contributions)) throw new Error(`Missing contributions for ${branch.name}`);
		const removed = new Set(branch.skipped.map((skip) => skip.branch));
		for (let index = contributions.items.length - 1; index >= 0; index--) {
			const spec = contributionSpec(config.branches[branch.name]!.contributions[index]!, "repository" in config.upstream);
			const name = contributionIdentity(spec, artifact.upstreamRepository);
			if (spec.cleanup === "when-merged" && removed.has(name)) contributions.delete(index);
		}
	}
	// Keep YAML comments, quoting and key order, without introducing schema defaults.
	RepoConfigFile.parse(document.toJS());
	return document.toString({ lineWidth: 0 });
}

/** Run only after every required build and branch publication succeeded. */
export async function publishConfigCleanup(
	artifact: RepositoryArtifact,
	github: Pick<GitHub, "readRepositoryFile" | "updateRepositoryFile">,
	repository: string,
	branch: string,
	dryRun: boolean,
): Promise<boolean> {
	const content = cleanedConfig(artifact);
	if (content === undefined || dryRun) return false;
	const original = artifact.config!;
	if (!/^repositories\/[^/]+\/[^/]+\/forkit\.yaml$/.test(original.path) || original.path.split("/").includes("..")) {
		throw new Error(`Invalid manifest path: ${original.path}`);
	}

	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await github.readRepositoryFile(repository, branch, original.path);
		if (current.content === content) return false; // Another run already cleaned it.
		if (current.content !== original.content) {
			throw new Error(`${original.path} changed since composition; compose again before cleanup`);
		}
		try {
			await github.updateRepositoryFile(
				repository, branch, original.path, current.sha, content,
				`chore: remove shipped contributions from ${artifact.repository}`,
			);
			return true;
		} catch (error) {
			// Other repository jobs can commit different manifests concurrently.
			// Re-read before retrying; never overwrite a changed manifest.
			if (!(error instanceof GitHubError) || error.status !== 409 || attempt === 2) throw error;
		}
	}
	return false;
}
