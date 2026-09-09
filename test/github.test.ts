import { afterEach, expect, spyOn, test } from "bun:test";
import { GitHub, GitHubError } from "../src/github/client.ts";

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
afterEach(() => fetchMock?.mockRestore());

test("manifest API reads the requested branch and writes UTF-8 content with a SHA guard", async () => {
	fetchMock = spyOn(globalThis, "fetch");
	const content = "# café\nbranches: {}\n";
	fetchMock.mockResolvedValueOnce(Response.json({
		type: "file", encoding: "base64", sha: "blob-sha", content: Buffer.from(content).toString("base64"),
	}));
	fetchMock.mockResolvedValueOnce(Response.json({ commit: { sha: "commit-sha" } }));
	const github = new GitHub("test-token");
	const path = "repositories/me/project/forkit.yaml";
	expect(await github.readRepositoryFile("me/forkit", "maintenance/test", path))
		.toEqual({ sha: "blob-sha", content });
	await github.updateRepositoryFile("me/forkit", "maintenance/test", path, "blob-sha", content, "cleanup");
	const [readUrl] = fetchMock.mock.calls[0]!;
	expect(String(readUrl)).toBe(`https://api.github.com/repos/me/forkit/contents/${path}?ref=maintenance%2Ftest`);
	const [writeUrl, options] = fetchMock.mock.calls[1]!;
	expect(String(writeUrl)).toBe(`https://api.github.com/repos/me/forkit/contents/${path}`);
	expect(options?.method).toBe("PUT");
	expect(JSON.parse(options?.body as string)).toEqual({
		branch: "maintenance/test", sha: "blob-sha", content: Buffer.from(content).toString("base64"), message: "cleanup",
	});
});

test("manifest API preserves conflicts for guarded cleanup retries", async () => {
	fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response("conflict", { status: 409 }));
	await expect(new GitHub("test-token").updateRepositoryFile("me/forkit", "main", "file", "sha", "text", "cleanup"))
		.rejects.toMatchObject({ status: 409, name: "GitHubError" } satisfies Partial<GitHubError>);
});
