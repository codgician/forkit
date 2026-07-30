import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

const PATH_TOOLS: Record<"read" | "grep" | "ls" | "edit", true> = {
	read: true,
	grep: true,
	ls: true,
	edit: true,
};

export interface ResolverToolPolicyOptions {
	root: string;
	conflictedPaths: readonly string[];
}

/** Install a fail-closed policy in front of every resolver tool call. */
export function createResolverToolPolicy(options: ResolverToolPolicyOptions): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", async (event) => {
			return checkResolverToolCall(options, event.toolName, event.input as Record<string, unknown>);
		});
	};
}

/**
 * Decide whether a tool call is safe to execute.
 *
 * Pi's built-in filesystem tools accept absolute paths and traversal. The
 * resolver needs repository reads, but it must never see the runner, process
 * environment, or authenticated Git metadata. Canonicalising both the root and
 * requested path also closes symlink escapes.
 */
export async function checkResolverToolCall(
	options: ResolverToolPolicyOptions,
	toolName: string,
	input: Record<string, unknown>,
): Promise<{ block: true; reason: string } | undefined> {
	if (!Object.hasOwn(PATH_TOOLS, toolName)) {
		return blocked(`Tool "${toolName}" is not available to the conflict resolver`);
	}

	const requested = requestedPath(toolName, input);
	if (requested === undefined) {
		return blocked(`Tool "${toolName}" requires a valid path`);
	}
	if (isAbsolute(requested)) {
		return blocked("Absolute paths are not available to the conflict resolver");
	}
	if (requested.split(/[\\/]/).includes("..")) {
		return blocked("Parent-directory traversal is not available to the conflict resolver");
	}

	try {
		const root = await realpath(options.root);
		const target = await realpath(resolve(root, requested));
		const relativePath = relative(root, target);

		if (!isContained(relativePath)) {
			return blocked("Paths outside the resolver worktree are not available");
		}

		const gitPath = relativePath.split(sep).join("/");
		if (gitPath.split("/").includes(".git")) {
			return blocked("Git metadata is not available to the conflict resolver");
		}

		if (
			toolName === "edit" &&
			!options.conflictedPaths.some((path) => path.replaceAll("\\", "/").replace(/^\.\//, "") === gitPath)
		) {
			return blocked("Only files reported by Git as conflicted may be edited");
		}
	} catch {
		// Missing, unreadable, malformed, and dangling-symlink paths all fail
		// closed. The resolver can choose another repository-local path.
		return blocked("The requested path is not an accessible worktree path");
	}

	return undefined;
}

function requestedPath(toolName: string, input: Record<string, unknown>): string | undefined {
	const value = input.path;
	if (value === undefined && (toolName === "grep" || toolName === "ls")) return ".";
	if (typeof value !== "string") return undefined;
	if (value.length === 0 && (toolName === "grep" || toolName === "ls")) return ".";
	return value.length > 0 ? value : undefined;
}

function isContained(relativePath: string): boolean {
	return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

function blocked(reason: string): { block: true; reason: string } {
	return { block: true, reason };
}
