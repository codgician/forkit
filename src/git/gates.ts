import type { Git } from "./git.ts";

export interface GateFailure {
	gate: string;
	detail: string;
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

/**
 * Checks every conflict resolution must pass before forkit commits or pushes it.
 *
 * These exist because a resolution may be authored by a model. They verify
 * observable properties of the tree, never the model's own account of what it
 * did. Any failure discards the resolution.
 */
export async function checkResolution(
	git: Git,
	conflictedPaths: string[],
	baseline: string,
): Promise<GateFailure[]> {
	const failures: GateFailure[] = [];

	const unmerged = await git.conflictedPaths();
	if (unmerged.length > 0) {
		failures.push({
			gate: "unmerged-entries",
			detail: `still unmerged: ${unmerged.join(", ")}`,
		});
	}

	const markers = await findConflictMarkers(git, conflictedPaths);
	if (markers.length > 0) {
		failures.push({
			gate: "conflict-markers",
			detail: `markers remain in: ${markers.join(", ")}`,
		});
	}

	// The resolver may read anything, but may only write files git marked
	// conflicted. This catches a model that "helpfully" edits something adjacent.
	const allowed = new Set(conflictedPaths);
	const outOfScope = (await git.changedPaths(baseline)).filter((path) => !allowed.has(path));
	if (outOfScope.length > 0) {
		failures.push({
			gate: "out-of-scope-edits",
			detail: `modified files outside the conflict: ${outOfScope.join(", ")}`,
		});
	}

	const whitespace = await git.git(["diff", "--check"], { check: false });
	if (whitespace.code !== 0) {
		failures.push({
			gate: "diff-check",
			detail: whitespace.stdout.trim().split("\n").slice(0, 10).join("\n"),
		});
	}

	return failures;
}

async function findConflictMarkers(git: Git, paths: string[]): Promise<string[]> {
	const found: string[] = [];

	for (const path of paths) {
		const file = Bun.file(`${git.cwd}/${path}`);
		if (!(await file.exists())) continue;

		// Conflict markers only appear in text; a binary read would be wasted.
		const text = await file.text().catch(() => "");
		if (CONFLICT_MARKER.test(text)) found.push(path);
	}

	return found;
}
