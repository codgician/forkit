import { parseRepoRef } from "../config/types.ts";

export interface Release {
	tag: string;
	prerelease: boolean;
	publishedAt: string | undefined;
}

export interface PullRequest {
	number: number;
	title: string;
	body: string;
	draft: boolean;
	state: "open" | "closed";
	merged: boolean;
	mergeCommitSha: string | undefined;
	/** Branch in the base repository this PR targets. */
	baseRef: string;
	/** owner/repo of the head, absent when the fork was deleted. */
	headRepo: string | undefined;
	headRef: string;
	headSha: string;
}

/** Everything one repository's run needs, fetched together. */
export interface UpstreamSnapshot {
	releases: Release[];
	tags: string[];
	openPullRequests: PullRequest[];
}

export class GitHubError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "GitHubError";
	}
}

/**
 * GitHub client built around a single GraphQL query per repository.
 *
 * REST would need roughly sixty requests per run for a repository the size of
 * litellm: fifteen pages of releases, fifteen of tags, and thirty to enumerate
 * ~3000 open pull requests looking for the handful that belong to the fork.
 * That exceeds the unauthenticated hourly budget on its own and wastes a large
 * share of an authenticated one. GraphQL asks for exactly the fields needed and
 * filters pull requests server-side by author.
 */
export class GitHub {
	constructor(private readonly token?: string) {}

	private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		if (!this.token) {
			throw new GitHubError("GitHub GraphQL requires a token; set GITHUB_TOKEN", 401);
		}

		const response = await fetch("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/json",
				"user-agent": "forkit",
			},
			body: JSON.stringify({ query, variables }),
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new GitHubError(
				`GraphQL request failed: ${response.status} ${response.statusText}\n${detail.slice(0, 400)}`,
				response.status,
			);
		}

		const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
		if (payload.errors?.length) {
			throw new GitHubError(payload.errors.map((error) => error.message).join("; "), 200);
		}
		if (!payload.data) throw new GitHubError("GraphQL response contained no data", 200);

		return payload.data;
	}

	/**
	 * The identity the token authenticates as, for commit authorship.
	 *
	 * Derived rather than configured: a hardcoded name that does not match the
	 * pushing account produces commits GitHub attributes to nobody, with no
	 * avatar and no link. The `<id>+<login>@users.noreply.github.com` form is
	 * what GitHub maps back to the account.
	 */
	async viewer(): Promise<{ name: string; email: string }> {
		const data = await this.graphql<{ viewer: { login: string; databaseId: number } }>(
			"query { viewer { login databaseId } }",
			{},
		);

		return {
			name: data.viewer.login,
			email: `${data.viewer.databaseId}+${data.viewer.login}@users.noreply.github.com`,
		};
	}

	/**
	 * Fetch releases, tags, and the fork's own open pull requests in one request.
	 *
	 * Only the newest `historyDepth` releases and tags are retrieved. Release
	 * selection always picks the highest semantic version, and a version older
	 * than the most recent hundred is never a sane target, so a deeper history
	 * would cost requests without changing any outcome.
	 */
	async snapshot(
		upstreamRepository: string,
		forkRepository: string,
		historyDepth = 100,
	): Promise<UpstreamSnapshot> {
		const { owner, repo } = parseRepoRef(upstreamRepository);
		const { owner: forkOwner } = parseRepoRef(forkRepository);

		const data = await this.graphql<SnapshotResponse>(SNAPSHOT_QUERY, {
			owner,
			repo,
			depth: historyDepth,
			// Author scoping is what keeps this bounded: the fork owner has a
			// handful of pull requests, the repository has thousands.
			search: `repo:${upstreamRepository} is:pr is:open author:${forkOwner}`,
		});

		return {
			releases: data.repository.releases.nodes
				.filter((node) => !node.isDraft)
				.map((node) => ({
					tag: node.tagName,
					prerelease: node.isPrerelease,
					publishedAt: node.publishedAt ?? undefined,
				})),
			tags: data.repository.refs.nodes.map((node) => node.name),
			openPullRequests: data.search.nodes
				.filter((node): node is RawPullRequest => node.number !== undefined)
				.map(toPullRequest)
				.filter((pull) => pull.headRepo === forkRepository)
				.sort((a, b) => a.number - b.number),
		};
	}

	/**
	 * The most recent pull request whose head is `branch` in the fork, open ones
	 * first. Used for contributions that are not in the open set, to recover the
	 * base they were written against and whether they have since merged.
	 */
	async findPullRequestForBranch(
		upstreamRepository: string,
		forkRepository: string,
		branch: string,
	): Promise<PullRequest | undefined> {
		const { owner: forkOwner } = parseRepoRef(forkRepository);

		const data = await this.graphql<{ search: { nodes: Partial<RawPullRequest>[] } }>(
			BRANCH_PULL_REQUEST_QUERY,
			{ search: `repo:${upstreamRepository} is:pr author:${forkOwner} head:${branch}` },
		);

		const candidates = data.search.nodes
			.filter((node): node is RawPullRequest => node.number !== undefined)
			.map(toPullRequest)
			.filter((pull) => pull.headRepo === forkRepository && pull.headRef === branch);

		return candidates.find((pull) => pull.state === "open") ?? candidates[0];
	}
}

const PULL_REQUEST_FIELDS = `
	number
	title
	body
	baseRefName
	headRefName
	headRefOid
	isDraft
	state
	merged
	mergeCommit { oid }
	headRepository { nameWithOwner }
`;

const SNAPSHOT_QUERY = `
query($owner: String!, $repo: String!, $depth: Int!, $search: String!) {
	repository(owner: $owner, name: $repo) {
		releases(first: $depth, orderBy: { field: CREATED_AT, direction: DESC }) {
			nodes { tagName isPrerelease isDraft publishedAt }
		}
		refs(refPrefix: "refs/tags/", first: $depth, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
			nodes { name }
		}
	}
	search(query: $search, type: ISSUE, first: 100) {
		nodes { ... on PullRequest { ${PULL_REQUEST_FIELDS} } }
	}
}`;

const BRANCH_PULL_REQUEST_QUERY = `
query($search: String!) {
	search(query: $search, type: ISSUE, first: 20) {
		nodes { ... on PullRequest { ${PULL_REQUEST_FIELDS} } }
	}
}`;

interface SnapshotResponse {
	repository: {
		releases: { nodes: { tagName: string; isPrerelease: boolean; isDraft: boolean; publishedAt: string | null }[] };
		refs: { nodes: { name: string }[] };
	};
	search: { nodes: Partial<RawPullRequest>[] };
}

interface RawPullRequest {
	number: number;
	title: string;
	body: string | null;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	isDraft: boolean;
	state: "OPEN" | "CLOSED" | "MERGED";
	merged: boolean;
	mergeCommit: { oid: string } | null;
	headRepository: { nameWithOwner: string } | null;
}

function toPullRequest(raw: RawPullRequest): PullRequest {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		draft: raw.isDraft,
		state: raw.state === "OPEN" ? "open" : "closed",
		merged: raw.merged,
		mergeCommitSha: raw.merged ? (raw.mergeCommit?.oid ?? undefined) : undefined,
		baseRef: raw.baseRefName,
		headRepo: raw.headRepository?.nameWithOwner,
		headRef: raw.headRefName,
		headSha: raw.headRefOid,
	};
}
