import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { checkResolverToolCall, createResolverToolPolicy } from "../src/ai/tool-policy.ts";

async function fixture(): Promise<{
	root: string;
	outsideFile: string;
	options: { root: string; conflictedPaths: string[] };
}> {
	const root = await mkdtemp(join(tmpdir(), "forkit-policy-root-"));
	const outside = await mkdtemp(join(tmpdir(), "forkit-policy-outside-"));
	const outsideFile = join(outside, "secret.txt");

	await mkdir(join(root, ".git"));
	await mkdir(join(root, "src"));
	await writeFile(join(root, ".git", "config"), "credential=secret\n");
	await writeFile(join(root, "conflicted.txt"), "conflict\n");
	await writeFile(join(root, "ordinary.txt"), "ordinary\n");
	await writeFile(join(root, "src", "dependency.ts"), "export {};\n");
	await writeFile(outsideFile, "secret\n");

	return {
		root,
		outsideFile,
		options: { root, conflictedPaths: ["conflicted.txt"] },
	};
}

describe("resolver tool policy", () => {
	test("allows repository reads and edits to conflicted files", async () => {
		const { options } = await fixture();

		expect(await checkResolverToolCall(options, "read", { path: "src/dependency.ts" })).toBeUndefined();
		expect(await checkResolverToolCall(options, "grep", {})).toBeUndefined();
		expect(await checkResolverToolCall(options, "ls", { path: "" })).toBeUndefined();
		expect(await checkResolverToolCall(options, "edit", { path: "conflicted.txt" })).toBeUndefined();
	});

	test("rejects absolute paths, traversal, Git metadata, and unrelated edits", async () => {
		const { outsideFile, options } = await fixture();

		expect(await checkResolverToolCall(options, "read", { path: outsideFile })).toMatchObject({ block: true });
		expect(await checkResolverToolCall(options, "read", { path: "../secret.txt" })).toMatchObject({ block: true });
		expect(await checkResolverToolCall(options, "read", { path: ".git/config" })).toMatchObject({ block: true });
		expect(await checkResolverToolCall(options, "edit", { path: "ordinary.txt" })).toMatchObject({ block: true });
	});

	test("rejects symlinks that escape the worktree or disguise Git metadata", async () => {
		const { root, outsideFile, options } = await fixture();
		await symlink(outsideFile, join(root, "outside-link"));
		await symlink(join(root, ".git", "config"), join(root, "config-link"));

		expect(await checkResolverToolCall(options, "read", { path: "outside-link" })).toMatchObject({ block: true });
		expect(await checkResolverToolCall(options, "read", { path: "config-link" })).toMatchObject({ block: true });
	});

	test("fails closed for malformed paths and unexpected tools", async () => {
		const { options } = await fixture();

		expect(await checkResolverToolCall(options, "read", {})).toMatchObject({ block: true });
		expect(await checkResolverToolCall(options, "read", { path: 42 })).toMatchObject({ block: true });
		expect(await checkResolverToolCall(options, "bash", { path: "conflicted.txt" })).toMatchObject({ block: true });
		expect(await checkResolverToolCall(options, "read", { path: "missing.txt" })).toMatchObject({ block: true });
	});

	test("loads the trusted inline policy while discovered extensions stay disabled", async () => {
		const { root, options } = await fixture();
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, ".forkit-agent"),
			extensionFactories: [createResolverToolPolicy(options)],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toHaveLength(1);
	});
});
