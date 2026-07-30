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

export interface BranchRule {
	/** Branch name in the fork that forkit maintains. */
	name: string;
	track: TrackSpec;
	/**
	 * Ordered fork branch names whose deltas are applied on top of the tracked
	 * source. Empty for mirror branches.
	 */
	contributions: string[];
	/** Full registry path, e.g. ghcr.io/codgician/litellm. Absent means never build. */
	image?: string;
}

export interface RepoConfig {
	/** owner/repo of the fork forkit writes to. */
	fork: string;
	upstream: {
		repository: string;
		/**
		 * Development branch: the merge-base for contributions without an open
		 * pull request, and the target of `track: { branch: upstream }`.
		 */
		branch: string;
	};
	maintainPullRequestBranches: boolean;
	onConflict: ConflictPolicy;
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
