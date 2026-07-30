/**
 * Instructions for the conflict resolver.
 *
 * Built into forkit rather than configured per repository: the task is the same
 * everywhere, and a per-repository prompt would be one more thing to keep in
 * sync with the engine's actual guarantees.
 */
export const SYSTEM_PROMPT = `You resolve a single git conflict. That is your only task.

The working tree contains conflict markers from a failed merge or patch
application. Conflicts are shown in diff3 style, so each region has three
parts: the current side, the common ancestor, and the incoming side.

Rules, in order of precedence:

1. Preserve the intent of the contribution. It is a deliberate change that
   someone wrote and wants to keep working.
2. Incorporate the upstream change rather than reverting it. Upstream moved
   for a reason; the contribution must be expressed in terms of the new code,
   not by restoring the old code.
3. Edit only inside conflicted regions of conflicted files. Never modify any
   other file, and never make unrelated improvements.
4. Never delete, skip, weaken, or comment out a test to make something pass.
5. Leave no conflict markers. Every <<<<<<<, =======, |||||||, and >>>>>>>
   must be gone.
6. If the two sides cannot be reconciled without guessing at intent, say so
   plainly instead of inventing a resolution.

Investigate before editing. Read the conflicted file, and read any file whose
API changed, so the resolution matches how the surrounding code now works.

When finished, reply with a short explanation of what upstream changed and how
you expressed the contribution against it. That explanation is recorded in the
commit message, so write it for someone reading git log a year from now.`;

export interface PromptInput {
	description: string;
	conflictedPaths: string[];
	upstreamCommits: string[];
	pullRequest: { number: number; title: string; body: string } | undefined;
	diff3: string;
}

export function buildPrompt(input: PromptInput): string {
	const sections = [
		`Resolve the conflict from: ${input.description}`,
		"",
		`Conflicted files:\n${input.conflictedPaths.map((path) => `- ${path}`).join("\n")}`,
	];

	if (input.pullRequest) {
		// The pull request body is the contribution's own statement of intent,
		// which is exactly what rule 1 asks to preserve.
		sections.push(
			"",
			`The contribution is upstream pull request #${input.pullRequest.number}: ${input.pullRequest.title}`,
			"",
			"Its description:",
			truncate(input.pullRequest.body, 4000),
		);
	}

	if (input.upstreamCommits.length > 0) {
		sections.push(
			"",
			"Upstream commits between the contribution's base and the target:",
			input.upstreamCommits.slice(0, 40).map((line) => `- ${line}`).join("\n"),
		);
	}

	sections.push(
		"",
		"Current conflicted state:",
		"```diff",
		truncate(input.diff3, 60_000),
		"```",
		"",
		"Read whatever you need, then edit the conflicted files so no markers remain.",
	);

	return sections.join("\n");
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n... [truncated ${text.length - limit} characters]`;
}
