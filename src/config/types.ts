/**
 * Runtime shapes derived from forkit.yaml, with shorthands resolved and
 * regexes compiled. The engine consumes these, never the raw file shape.
 */

/** How a branch decides which upstream commit it is based on. */
export type TrackSpec =
	| { kind: "branch"; branch: string }
	| { kind: "releases"; prerelease: "only" | "exclude" | "any"; match?: RegExp }
	| { kind: "tags"; match: RegExp };

export type ConflictPolicy = "ai" | "fail";
export type ContributionSpec = (
	| { type: "branch"; name: string }
	| { type: "pr"; number: number }
) & {
	/** Exact start of this patch's delta, including for stacked patches. */
	base?: string;
	cleanup?: "manual" | "when-merged";
};

export function contributionSpec(value: ContributionSpec, githubUpstream: boolean): ContributionSpec & { cleanup: "manual" | "when-merged" } {
	return { ...value, cleanup: value.cleanup ?? (githubUpstream ? "when-merged" : "manual") };
}

export function contributionIdentity(value: ContributionSpec, upstreamRepository: string): string {
	return value.type === "branch" ? value.name : `${upstreamRepository}#${value.number}`;
}

export interface UpstreamSpec {
	repository?: string;
	git?: string;
	branch: string;
}

export function upstreamIdentity(upstream: UpstreamSpec): string {
	return upstream.repository ?? upstream.git!;
}

export function upstreamGitUrl(upstream: UpstreamSpec): string {
	return upstream.git ?? `https://github.com/${upstream.repository}.git`;
}

export interface BranchRule {
	/** Branch name in the fork that forkit maintains. */
	name: string;
	track: TrackSpec;
	/**
	 * Ordered branch or pull-request contributions whose deltas are applied on
	 * top of the tracked source. Empty means the branch is a direct mirror.
	 */
	contributions: ContributionSpec[];
	/** What to do when applying a contribution conflicts. */
	onConflict: ConflictPolicy;
	/** Absent means this branch is never built. */
	container?: ContainerSpec;
	/** Executed in an isolated source archive before this target is published. */
	validation?: { command: string[]; timeout_minutes: number };
}

export interface ContainerSpec {
	/** Full registry path, e.g. ghcr.io/codgician/litellm. */
	image: string;
	/** Dockerfile path relative to the composed worktree. */
	dockerfile: string;
	/** Built as one manifest list, so a tag never encodes an architecture. */
	platforms: string[];
	/** Proves the built image runs. Absent means a successful build suffices. */
	smoke?: { entrypoint?: string; command: string[] };
}

export interface RepoConfig {
	/** owner/repo of the fork forkit writes to. */
	fork: string;
	upstream: UpstreamSpec;
	branches: BranchRule[];
	/** Absolute path to the directory holding this forkit.yaml. */
	configDir: string;
}

export interface RepoRef {
	owner: string;
	repo: string;
}

export function parseRepoRef(slug: string): RepoRef {
	const [owner, repo] = slug.split("/");
	if (!owner || !repo) throw new Error(`Expected "owner/repo", got "${slug}"`);
	return { owner, repo };
}

/**
 * OCI tags allow [A-Za-z0-9_.-] only, must not lead with a separator, and cap
 * at 128 characters. Branch names routinely violate all three.
 */
export function toOciTag(value: string): string {
	const tag = value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[.-]+/, "").slice(0, 128);
	if (tag.length === 0) throw new Error(`Cannot derive an OCI tag from "${value}"`);
	return tag;
}
