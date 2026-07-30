import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../git/git.ts";

export const UPSTREAM_REMOTE = "upstream";
export const FORK_REMOTE = "fork";

export interface WorkspaceOptions {
	forkRepository: string;
	upstreamRepository: string;
	/** Token used for the authenticated push URL. Reads stay anonymous. */
	token?: string;
	/**
	 * Identity for the commits forkit authors. It must be the account the token
	 * belongs to, or GitHub shows the commits as authored by nobody.
	 */
	committer: Committer;
	/** Reuse an existing checkout instead of cloning. */
	directory?: string;
}

export interface Committer {
	name: string;
	email: string;
}

/**
 * A checkout with both remotes configured.
 *
 * Cloned bare-ish and fetched narrowly: forkit only ever needs the specific
 * refs a run touches, and litellm's full history is large enough that fetching
 * it per run would dominate the runtime.
 */
export class Workspace {
	private constructor(
		readonly git: Git,
		private readonly ephemeral: boolean,
	) {}

	static async create(options: WorkspaceOptions): Promise<Workspace> {
		const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "forkit-work-")));
		const git = new Git(directory);

		await git.git(["init", "--quiet"]);
		await git.addRemote(UPSTREAM_REMOTE, `https://github.com/${options.upstreamRepository}.git`);
		await git.addRemote(
			FORK_REMOTE,
			options.token
				? `https://x-access-token:${options.token}@github.com/${options.forkRepository}.git`
				: `https://github.com/${options.forkRepository}.git`,
		);

		// Identity for the synthetic commits forkit authors.
		await git.git(["config", "user.name", options.committer.name]);
		await git.git(["config", "user.email", options.committer.email]);
		await git.git(["config", "commit.gpgsign", "false"]);
		// Deterministic conflict markers, and diff3 gives the resolver the merge
		// base as well as both sides.
		await git.git(["config", "merge.conflictStyle", "diff3"]);

		return new Workspace(git, options.directory === undefined);
	}

	/** Fetch specific refs from a remote, unshallowed only as deep as needed. */
	async fetch(remote: string, refspecs: string[]): Promise<void> {
		if (refspecs.length === 0) return;
		await this.git.fetch(remote, refspecs);
	}

	async dispose(): Promise<void> {
		if (!this.ephemeral) return;
		await rm(this.git.cwd, { recursive: true, force: true }).catch(() => {});
	}
}
