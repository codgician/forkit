import { type RunResult, run } from "../util/exec.ts";

/** Paths git reported as conflicted, plus the merge that produced them. */
export interface ConflictState {
	paths: string[];
	/** Commit the merge or apply was attempted against. */
	ours: string;
	theirs: string;
}

/**
 * A git repository forkit operates on. All state is on disk; this class only
 * wraps argv construction so no branch or ref name is ever shell-interpolated.
 */
export class Git {
	constructor(readonly cwd: string) {}

	async git(args: string[], options: { check?: boolean; stdin?: string } = {}): Promise<RunResult> {
		return run(["git", ...args], { cwd: this.cwd, ...options });
	}

	/** stdout with trailing newline removed, for single-value queries. */
	private async value(args: string[]): Promise<string> {
		const { stdout } = await this.git(args);
		return stdout.trim();
	}

	async revParse(ref: string): Promise<string> {
		return this.value(["rev-parse", "--verify", `${ref}^{commit}`]);
	}

	async exists(ref: string): Promise<boolean> {
		const { code } = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
			check: false,
		});
		return code === 0;
	}

	async mergeBase(a: string, b: string): Promise<string> {
		return this.value(["merge-base", a, b]);
	}

	/** True when `ancestor` is reachable from `descendant`. */
	async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
		const { code } = await this.git(["merge-base", "--is-ancestor", ancestor, descendant], {
			check: false,
		});
		return code === 0;
	}

	async fetch(remote: string, refspecs: string[], options: { tags?: boolean } = {}): Promise<void> {
		await this.git([
			"fetch",
			"--no-write-fetch-head",
			...(options.tags ? ["--tags", "--force"] : []),
			remote,
			...refspecs,
		]);
	}

	async addRemote(name: string, url: string): Promise<void> {
		const { code } = await this.git(["remote", "get-url", name], { check: false });
		if (code === 0) {
			await this.git(["remote", "set-url", name, url]);
			return;
		}
		await this.git(["remote", "add", name, url]);
	}

	async checkoutDetached(commit: string): Promise<void> {
		await this.git(["checkout", "--detach", "--force", commit]);
		await this.git(["clean", "-fdx"]);
	}

	/**
	 * Apply the diff `base..head` onto the current HEAD, keeping conflict markers
	 * on failure so a resolver can inspect them.
	 *
	 * Uses the index-aware three-way path rather than `git merge`, so unrelated
	 * commits between the contribution's base and the current HEAD do not come
	 * along with it.
	 */
	async applyDelta(base: string, head: string): Promise<ConflictState | undefined> {
		const patch = await this.git(["diff", "--binary", `${base}..${head}`]);
		if (patch.stdout.trim().length === 0) return undefined;

		const applied = await this.git(["apply", "--3way", "--whitespace=nowarn", "-"], {
			check: false,
			stdin: patch.stdout,
		});
		if (applied.code === 0) return undefined;

		const paths = await this.conflictedPaths();
		if (paths.length === 0) {
			throw new Error(`Applying ${base}..${head} failed without conflicts:\n${applied.stderr.trim()}`);
		}
		return { paths, ours: await this.revParse("HEAD"), theirs: head };
	}

	/** Merge `ref` into the current branch, leaving markers on conflict. */
	async merge(ref: string, message: string): Promise<ConflictState | undefined> {
		const result = await this.git(["merge", "--no-ff", "--no-edit", "-m", message, ref], {
			check: false,
		});
		if (result.code === 0) return undefined;

		const paths = await this.conflictedPaths();
		if (paths.length === 0) {
			await this.git(["merge", "--abort"], { check: false });
			throw new Error(`Merging ${ref} failed without conflicts:\n${result.stderr.trim()}`);
		}
		return { paths, ours: await this.revParse("HEAD"), theirs: await this.revParse(ref) };
	}

	async conflictedPaths(): Promise<string[]> {
		const { stdout } = await this.git(["diff", "--name-only", "--diff-filter=U"]);
		return stdout.split("\n").filter((line) => line.length > 0);
	}

	/** Paths differing from `ref`, whether staged, unstaged, or untracked. */
	async changedPaths(ref = "HEAD"): Promise<string[]> {
		const tracked = await this.git(["diff", "--name-only", ref]);
		const untracked = await this.git(["ls-files", "--others", "--exclude-standard"]);
		const paths = [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")];
		return [...new Set(paths.filter((line) => line.length > 0))].sort();
	}

	/** Paths a contribution's delta would touch, without applying it. */
	async changedPathsBetween(base: string, head: string): Promise<string[]> {
		const { stdout } = await this.git(["diff", "--name-only", `${base}..${head}`]);
		return stdout.split("\n").filter((line) => line.length > 0);
	}

	async commitAll(message: string, options: { allowEmpty?: boolean } = {}): Promise<string> {
		await this.git(["add", "--all"]);
		await this.git([
			"commit",
			"--no-verify",
			...(options.allowEmpty ? ["--allow-empty"] : []),
			"-m",
			message,
		]);
		return this.revParse("HEAD");
	}

	/** Replace `branch` with the current HEAD, locally. */
	async setBranch(branch: string, commit: string): Promise<void> {
		await this.git(["branch", "--force", branch, commit]);
	}

	/**
	 * Push, refusing to clobber a remote that moved since it was observed.
	 *
	 * `expected` is the remote tip forkit read at the start of the run. Passing
	 * undefined asserts the branch does not yet exist remotely.
	 */
	async pushWithLease(
		remote: string,
		branch: string,
		commit: string,
		expected: string | undefined,
	): Promise<void> {
		await this.git([
			"push",
			`--force-with-lease=refs/heads/${branch}:${expected ?? ""}`,
			remote,
			`${commit}:refs/heads/${branch}`,
		]);
	}

	async pushFastForward(remote: string, branch: string, commit: string): Promise<void> {
		await this.git(["push", remote, `${commit}:refs/heads/${branch}`]);
	}

	/** Remote branch tip, or undefined when the branch does not exist. */
	async remoteTip(remote: string, branch: string): Promise<string | undefined> {
		const { stdout } = await this.git(["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
		const sha = stdout.split("\t")[0]?.trim();
		return sha && sha.length > 0 ? sha : undefined;
	}

	async shortSha(commit: string): Promise<string> {
		return this.value(["rev-parse", "--short=8", commit]);
	}

	/** Subject lines of `range`, newest first, for conflict context. */
	async logSubjects(range: string, limit = 40): Promise<string[]> {
		const { stdout } = await this.git(["log", `--max-count=${limit}`, "--format=%h %s", range]);
		return stdout.split("\n").filter((line) => line.length > 0);
	}

	async diff(args: string[]): Promise<string> {
		const { stdout } = await this.git(["diff", ...args]);
		return stdout;
	}


	async updateRef(ref: string, commit: string): Promise<void> {
		await this.git(["update-ref", ref, commit]);
	}

	async createBundle(path: string, refs: string[]): Promise<void> {
		if (refs.length === 0) throw new Error("Cannot create an empty git bundle");
		await this.git(["bundle", "create", path, ...refs]);
	}

	async fetchBundle(path: string, ref: string): Promise<void> {
		await this.git(["fetch", path, `${ref}:refs/forkit/checkout`]);
		await this.checkoutDetached("refs/forkit/checkout");
	}
	/** True when the working tree has no staged or unstaged changes. */
	async isClean(): Promise<boolean> {
		const { stdout } = await this.git(["status", "--porcelain"]);
		return stdout.trim().length === 0;
	}
}
