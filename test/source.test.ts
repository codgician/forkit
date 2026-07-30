import { describe, expect, test } from "bun:test";
import type { TrackSpec } from "../src/config/types.ts";
import { NoMatchingSourceError, resolveSource } from "../src/engine/source.ts";
import type { Release, UpstreamSnapshot } from "../src/github/client.ts";
import { compareSemVer, parseSemVer } from "../src/util/semver.ts";

/**
 * Real litellm release ordering, newest publication first. Note v1.90.6 and
 * v1.91.4 appear *after* v1.93.0: GitHub orders by publication date, so a
 * date-based selection would pick a backport over the newest line.
 */
const LITELLM_RELEASES: Release[] = [
	{ tag: "v1.95.0-rc.1", prerelease: true, publishedAt: "2026-07-30T00:12:53Z" },
	{ tag: "v1.94.0", prerelease: false, publishedAt: "2026-07-28T21:26:24Z" },
	{ tag: "v1.95.0-dev.2", prerelease: true, publishedAt: "2026-07-28T20:00:00Z" },
	{ tag: "v1.94.0-rc.3", prerelease: true, publishedAt: "2026-07-27T10:00:00Z" },
	{ tag: "v1.93.0", prerelease: false, publishedAt: "2026-07-25T10:00:00Z" },
	{ tag: "v1.92.1", prerelease: false, publishedAt: "2026-07-24T10:00:00Z" },
	{ tag: "v1.91.4", prerelease: false, publishedAt: "2026-07-23T10:00:00Z" },
	{ tag: "v1.90.6", prerelease: false, publishedAt: "2026-07-22T10:00:00Z" },
];

function snapshot(releases = LITELLM_RELEASES, tags = releases.map((r) => r.tag)): UpstreamSnapshot {
	return { releases, tags, openPullRequests: [] };
}

const STABLE_ONLY = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

describe("semver ordering", () => {
	test("parses and rejects", () => {
		expect(parseSemVer("v1.94.0")).toEqual({ major: 1, minor: 94, patch: 0, prerelease: [] });
		expect(parseSemVer("v1.95.0-rc.1")?.prerelease).toEqual(["rc", "1"]);
		expect(parseSemVer("not-a-version")).toBeUndefined();
	});

	test("orders releases above their prereleases", () => {
		const release = parseSemVer("v1.95.0")!;
		const rc = parseSemVer("v1.95.0-rc.1")!;
		expect(compareSemVer(release, rc)).toBeGreaterThan(0);
		expect(compareSemVer(parseSemVer("v1.95.0-rc.2")!, rc)).toBeGreaterThan(0);
		expect(compareSemVer(parseSemVer("v1.95.0-rc.1")!, parseSemVer("v1.95.0-dev.9")!)).toBeGreaterThan(0);
	});

	test("orders numerically, not lexically", () => {
		expect(compareSemVer(parseSemVer("v1.94.0")!, parseSemVer("v1.9.0")!)).toBeGreaterThan(0);
		expect(compareSemVer(parseSemVer("v1.90.6")!, parseSemVer("v1.9.6")!)).toBeGreaterThan(0);
	});
});

describe("resolveSource", () => {
	test("branch tracking resolves to a branch refspec", async () => {
		const track: TrackSpec = { kind: "branch", branch: "main" };
		expect(resolveSource(track, "BerriAI/litellm", snapshot())).toEqual({
			ref: "main",
			fetchSpec: "refs/heads/main",
			kind: "branch",
		});
	});

	test("selects the newest stable release", async () => {
		const track: TrackSpec = { kind: "releases", prerelease: "exclude", match: STABLE_ONLY };
		const source = resolveSource(track, "BerriAI/litellm", snapshot());
		expect(source).toEqual({ ref: "v1.94.0", fetchSpec: "refs/tags/v1.94.0", kind: "releases" });
	});

	test("never downgrades to a backport published after a newer line", async () => {
		// A 1.90 patch released today, after v1.94.0 already shipped.
		const withBackport: Release[] = [
			{ tag: "v1.90.7", prerelease: false, publishedAt: "2026-07-31T00:00:00Z" },
			...LITELLM_RELEASES,
		];
		const track: TrackSpec = { kind: "releases", prerelease: "exclude", match: STABLE_ONLY };

		const source = resolveSource(track, "BerriAI/litellm", snapshot(withBackport));
		expect(source.ref).toBe("v1.94.0");
	});

	test("prerelease: true alone would follow dev builds, match narrows to rc", async () => {
		const anyPrerelease: TrackSpec = { kind: "releases", prerelease: "only" };
		expect((resolveSource(anyPrerelease, "BerriAI/litellm", snapshot())).ref).toBe("v1.95.0-rc.1");

		// With a dev build newer than the rc, the unfiltered form drifts channel.
		const devNewer: Release[] = [
			{ tag: "v1.96.0-dev.1", prerelease: true, publishedAt: "2026-07-31T00:00:00Z" },
			...LITELLM_RELEASES,
		];
		expect((resolveSource(anyPrerelease, "BerriAI/litellm", snapshot(devNewer))).ref).toBe(
			"v1.96.0-dev.1",
		);

		const rcOnly: TrackSpec = { kind: "releases", prerelease: "only", match: /-rc\.[0-9]+$/ };
		expect((resolveSource(rcOnly, "BerriAI/litellm", snapshot(devNewer))).ref).toBe("v1.95.0-rc.1");
	});

	test("match can pin a release line", async () => {
		const track: TrackSpec = { kind: "releases", prerelease: "exclude", match: /^v1\.9[0-2]\./ };
		expect((resolveSource(track, "BerriAI/litellm", snapshot())).ref).toBe("v1.92.1");
	});

	test("prerelease: any considers both channels", async () => {
		const track: TrackSpec = { kind: "releases", prerelease: "any" };
		expect((resolveSource(track, "BerriAI/litellm", snapshot())).ref).toBe("v1.95.0-rc.1");
	});

	test("tag tracking resolves to a tag refspec", async () => {
		const track: TrackSpec = { kind: "tags", match: STABLE_ONLY };
		expect(resolveSource(track, "BerriAI/litellm", snapshot())).toEqual({
			ref: "v1.94.0",
			fetchSpec: "refs/tags/v1.94.0",
			kind: "tags",
		});
	});

	test("reports what it considered when nothing matches", () => {
		const track: TrackSpec = { kind: "releases", prerelease: "exclude", match: /-stable$/ };
		const attempt = () => resolveSource(track, "BerriAI/litellm", snapshot());

		expect(attempt).toThrow(NoMatchingSourceError);
		// The original design used a `-stable` suffix that litellm never publishes;
		// the error has to make that obvious rather than failing opaquely.
		expect(attempt).toThrow(/No release in BerriAI\/litellm matches/);

		try {
			attempt();
		} catch (error) {
			expect((error as NoMatchingSourceError).considered).toContain("v1.94.0");
		}
	});
});
