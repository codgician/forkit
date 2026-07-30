import { z } from "zod";

/**
 * The forkit.yaml schema.
 *
 * One file per managed repository at repositories/<owner>/<repo>/forkit.yaml.
 * There is no central registry: repositories are discovered by glob.
 */

const RepoSlug = z
	.string()
	.regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"');

const Regex = z.string().refine(
	(pattern) => {
		try {
			new RegExp(pattern);
			return true;
		} catch {
			return false;
		}
	},
	{ message: "must be a valid regular expression" },
);

/** `false` excludes prereleases, `true` selects only them, `"any"` ignores the flag. */
const Prerelease = z.union([z.boolean(), z.literal("any")]).default(false);

const TrackByBranch = z.object({ branch: z.string().min(1) }).strict();

const TrackByReleases = z
	.object({
		releases: z
			.object({ prerelease: Prerelease, match: Regex.optional() })
			.strict(),
	})
	.strict();

const TrackByTags = z
	.object({ tags: z.object({ match: Regex }).strict() })
	.strict();

/**
 * Exactly one tracking form per branch. A union of strict objects gives that
 * for free: extra keys make the other members fail.
 */
const Track = z.union([TrackByBranch, TrackByReleases, TrackByTags]);

const Container = z
	.object({
		image: z.string().min(1),
		/** Dockerfile path relative to the composed worktree. */
		dockerfile: z.string().min(1).default("Dockerfile"),
		/**
		 * Platforms to build, as an OCI manifest list under one tag.
		 *
		 * A tag must mean the same build everywhere, so an architecture never
		 * appears in the image name. Clients select by their own platform.
		 */
		platforms: z
			.array(z.string().regex(/^[a-z0-9]+\/[a-z0-9]+(\/v[0-9]+)?$/, "must look like linux/amd64"))
			.min(1)
			.default(["linux/amd64"]),
		/**
		 * Command proving the built image runs, as argv. Executed directly, so
		 * there is no shell for a branch or tag name to escape into.
		 *
		 * Absent means the image is published on a successful build alone.
		 */
		smoke: z
			.object({
				entrypoint: z.string().min(1).optional(),
				command: z.array(z.string()).min(1),
			})
			.strict()
			.optional(),
	})
	.strict();

/**
 * What to do when applying a contribution conflicts.
 *
 * Defaults to failing: a branch opts in to being resolved by a model, rather
 * than inheriting it.
 */
const OnConflict = z.enum(["ai", "fail"]).default("fail");

const BranchRule = z
	.object({
		track: Track,
		contributions: z
			.array(z.string().min(1))
			.default([])
			.refine((list) => new Set(list).size === list.length, {
				message: "lists the same branch more than once",
			}),
		on_conflict: OnConflict,
		container: Container.optional(),
	})
	.strict()
	.refine((rule) => !("branch" in rule.track) || rule.contributions.length === 0, {
		message: "a branch that mirrors upstream cannot declare `contributions`",
		path: ["contributions"],
	});

export const RepoConfigFile = z
	.object({
		fork: RepoSlug,
		upstream: z.object({ repository: RepoSlug, branch: z.string().min(1) }).strict(),
		branches: z.record(z.string().min(1), BranchRule),
	})
	.strict()
	.refine((config) => config.fork !== config.upstream.repository, {
		message: "`fork` and `upstream.repository` must differ",
		path: ["fork"],
	})
	.refine((config) => Object.keys(config.branches).length > 0, {
		message: "must declare at least one branch",
		path: ["branches"],
	});

export type RepoConfigFile = z.infer<typeof RepoConfigFile>;
export type BranchRuleFile = z.infer<typeof BranchRule>;
export type TrackFile = z.infer<typeof Track>;
