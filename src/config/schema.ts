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

const ContributionOptions = {
	base: z.string().regex(/^[0-9a-f]{40}$/, "must be a full base commit SHA").optional(),
	cleanup: z.enum(["manual", "when-merged"]).optional(),
};

const Contribution = z.discriminatedUnion("type", [
	z.object({ type: z.literal("branch"), name: z.string().min(1), ...ContributionOptions }).strict(),
	z.object({ type: z.literal("pr"), number: z.number().int().positive().safe(), ...ContributionOptions }).strict(),
]);

const Upstream = z.union([
	z.object({ repository: RepoSlug, branch: z.string().min(1) }).strict(),
	z.object({
		git: z.url().refine((value) => {
			try {
				const url = new URL(value);
				return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
			} catch {
				return false;
			}
		}, "must be an HTTPS Git URL without credentials, query or fragment"),
		branch: z.string().min(1),
	}).strict(),
]);
function contributionKey(contribution: z.infer<typeof Contribution>): string {
	return contribution.type === "branch"
		? `branch:${contribution.name}`
		: `pr:${contribution.number}`;
}

const BranchRule = z
	.object({
		track: Track,
		contributions: z
			.array(Contribution)
			.default([])
			.refine((list) => new Set(list.map(contributionKey)).size === list.length, {
				message: "lists the same contribution more than once",
			}),
		on_conflict: OnConflict,
		container: Container.optional(),
		validation: z.object({
			command: z.array(z.string().min(1)).min(1),
			timeout_minutes: z.number().int().min(1).max(120).default(30),
		}).strict().optional(),
	})
	.strict();

export const RepoConfigFile = z
	.object({
		fork: RepoSlug,
		upstream: Upstream,
		branches: z.record(z.string().min(1), BranchRule),
	})
	.strict()
	.refine((config) => !("repository" in config.upstream) || config.fork !== config.upstream.repository, {
		message: "`fork` and `upstream.repository` must differ",
		path: ["fork"],
	})
	.refine((config) => Object.keys(config.branches).length > 0, {
		message: "must declare at least one branch",
		path: ["branches"],
	})
	.superRefine((config, context) => {
		for (const [name, rule] of Object.entries(config.branches)) {
			if ("git" in config.upstream && "releases" in rule.track) {
				context.addIssue({ code: "custom", path: ["branches", name, "track"], message: "releases require a GitHub upstream; use branch or tags for a Git URL" });
			}
			for (const item of rule.contributions) {
				if (item.type === "branch" && Object.hasOwn(config.branches, item.name)) {
					context.addIssue({ code: "custom", path: ["branches", name, "contributions"], message: `contribution ${item.name} is also a generated target` });
				}
				if ("git" in config.upstream && (item.type === "pr" || item.cleanup === "when-merged")) {
					context.addIssue({ code: "custom", path: ["branches", name, "contributions"], message: "PR contributions and when-merged cleanup require a GitHub upstream" });
				}
			}
		}
	});

export type RepoConfigFile = z.infer<typeof RepoConfigFile>;
export type BranchRuleFile = z.infer<typeof BranchRule>;
export type TrackFile = z.infer<typeof Track>;
