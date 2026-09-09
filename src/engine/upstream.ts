import { contributionSpec, type RepoConfig } from "../config/types.ts";
import type { Git } from "../git/git.ts";
import type { GitHub, UpstreamSnapshot } from "../github/client.ts";
import { UPSTREAM_REMOTE } from "./workspace.ts";

/** Git supplies refs; hosting APIs are optional release/review metadata. */
export async function upstreamSnapshot(config: RepoConfig, git: Git, github: GitHub): Promise<UpstreamSnapshot> {
	const needsMetadata = config.branches.some((rule) => rule.track.kind === "releases" ||
		rule.contributions.some((item) => contributionSpec(item, true).cleanup === "when-merged"));
	const snapshot: UpstreamSnapshot = config.upstream.repository && needsMetadata
		? await github.snapshot(config.upstream.repository, config.fork)
		: { releases: [], tags: [], openPullRequests: [] };
	const matchers = config.branches.flatMap((rule) => rule.track.kind === "tags" ? [rule.track.match] : []);
	if (matchers.length) {
		const { stdout } = await git.git(["ls-remote", "--tags", "--refs", UPSTREAM_REMOTE]);
		const tags = stdout.trim().split("\n").flatMap((line) => {
			const ref = line.split("\t")[1];
			return ref?.startsWith("refs/tags/") && matchers.some((match) => match.test(ref.slice(10))) ? [ref] : [];
		});
		if (tags.length) {
			await git.fetch(UPSTREAM_REMOTE, tags.map((ref) => `+${ref}:${ref}`));
			const ordered = await git.git(["for-each-ref", "--sort=refname", "--sort=-creatordate", "--format=%(refname:strip=2)", "refs/tags/"]);
			snapshot.tags = ordered.stdout.trim().split("\n").filter(Boolean);
		} else {
			snapshot.tags = [];
		}
	}
	return snapshot;
}
