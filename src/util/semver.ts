/**
 * Semantic version ordering.
 *
 * Releases must be ordered by version, not by publication date: a backport
 * published after a newer line (v1.90.7 after v1.94.0) is newer by date but
 * older by version, and selecting it would silently downgrade a branch.
 */

export interface SemVer {
	major: number;
	minor: number;
	patch: number;
	/** Dot-separated prerelease identifiers, empty for a release version. */
	prerelease: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemVer(tag: string): SemVer | undefined {
	const match = SEMVER.exec(tag.trim());
	if (!match) return undefined;

	const [, major, minor, patch, prerelease] = match;
	return {
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		prerelease: prerelease ? prerelease.split(".") : [],
	};
}

/** Negative when `a` precedes `b`, following the semver precedence rules. */
export function compareSemVer(a: SemVer, b: SemVer): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;

	// A version with a prerelease precedes the equivalent release version.
	if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
	if (a.prerelease.length === 0) return 1;
	if (b.prerelease.length === 0) return -1;

	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
		const left = a.prerelease[index];
		const right = b.prerelease[index];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		if (left === right) continue;

		const leftNumeric = /^\d+$/.test(left);
		const rightNumeric = /^\d+$/.test(right);
		if (leftNumeric && rightNumeric) return Number(left) - Number(right);
		// Numeric identifiers always have lower precedence than alphanumeric ones.
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return left < right ? -1 : 1;
	}

	return 0;
}
