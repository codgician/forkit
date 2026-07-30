import type { TrackSpec } from "../config/types.ts";
import type { Release, UpstreamSnapshot } from "../github/client.ts";
import { compareSemVer, parseSemVer } from "../util/semver.ts";

/** The upstream ref a branch is based on for this run. */
export interface ResolvedSource {
	/** Human-readable ref: a tag name, or a branch name for mirrors. */
	ref: string;
	/** Refspec to fetch from the upstream remote. */
	fetchSpec: string;
	kind: TrackSpec["kind"];
}

export class NoMatchingSourceError extends Error {
	constructor(message: string, readonly considered: string[]) {
		super(message);
		this.name = "NoMatchingSourceError";
	}
}

/**
 * Choose the upstream ref a branch is based on.
 *
 * Pure over an already-fetched snapshot: every branch of a repository resolves
 * against the same one, so a run costs one API request no matter how many
 * branches it maintains.
 */
export function resolveSource(
	track: TrackSpec,
	upstreamRepository: string,
	snapshot: UpstreamSnapshot,
): ResolvedSource {
	if (track.kind === "branch") {
		return {
			ref: track.branch,
			fetchSpec: `refs/heads/${track.branch}`,
			kind: "branch",
		};
	}

	if (track.kind === "tags") {
		const matching = snapshot.tags.filter((tag) => track.match.test(tag));
		if (matching.length === 0) {
			throw new NoMatchingSourceError(
				`No tag in ${upstreamRepository} matches ${track.match}`,
				snapshot.tags.slice(0, 20),
			);
		}
		const newest = selectNewest(matching);
		return { ref: newest, fetchSpec: `refs/tags/${newest}`, kind: "tags" };
	}

	const eligible = snapshot.releases.filter((release) => matchesRelease(release, track));
	if (eligible.length === 0) {
		throw new NoMatchingSourceError(
			`No release in ${upstreamRepository} matches ${describe(track)}`,
			snapshot.releases
				.slice(0, 20)
				.map((release) => `${release.tag}${release.prerelease ? " (prerelease)" : ""}`),
		);
	}

	const newest = selectNewest(eligible.map((release) => release.tag));
	return { ref: newest, fetchSpec: `refs/tags/${newest}`, kind: "releases" };
}

function matchesRelease(release: Release, track: Extract<TrackSpec, { kind: "releases" }>): boolean {
	if (track.prerelease === "exclude" && release.prerelease) return false;
	if (track.prerelease === "only" && !release.prerelease) return false;
	return track.match ? track.match.test(release.tag) : true;
}

/**
 * Newest by semantic version, falling back to the API's own ordering (newest
 * publication first) only for tags that are not semver.
 */
function selectNewest(tags: string[]): string {
	const parsed = tags.map((tag) => ({ tag, version: parseSemVer(tag) }));
	const semver = parsed.filter((entry) => entry.version !== undefined);

	if (semver.length === 0) {
		const [first] = tags;
		if (!first) throw new Error("selectNewest requires at least one tag");
		return first;
	}

	const sorted = semver.sort((a, b) => compareSemVer(b.version!, a.version!));
	return sorted[0]!.tag;
}

function describe(track: Extract<TrackSpec, { kind: "releases" }>): string {
	const parts = [`prerelease: ${track.prerelease}`];
	if (track.match) parts.push(`match: ${track.match}`);
	return parts.join(", ");
}
