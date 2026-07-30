import {
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { ConflictResolver, ResolverContext, ResolverOutcome } from "../engine/compose.ts";
import { DENDRO_PROVIDER, dendroModel } from "./model.ts";
import { SYSTEM_PROMPT, buildPrompt } from "./prompt.ts";
import { createResolverToolPolicy } from "./tool-policy.ts";
import { Trajectory } from "./trajectory.ts";

export interface AiResolverOptions {
	apiKey: string;
	trajectoryDirectory: string;
	/**
	 * Reasoning effort. Configurable because `xhigh` is model-specific and this
	 * request passes through a proxy that may not forward it; the recorded token
	 * usage is what confirms whether it took effect.
	 */
	thinkingLevel?: "low" | "medium" | "high" | "xhigh";
	timeoutMs?: number;
}

/**
 * Resolves conflicts with the pi SDK.
 *
 * The agent runs against a disposable worktree with a read-and-edit tool set.
 * `bash` and `write` are withheld deliberately: the checkout has push-capable
 * remotes, and resolving a conflict requires neither running commands nor
 * creating files.
 */
export class AiConflictResolver implements ConflictResolver {
	constructor(private readonly options: AiResolverOptions) {}

	async resolve(context: ResolverContext): Promise<ResolverOutcome> {
		const thinkingLevel = this.options.thinkingLevel ?? "xhigh";
		const model = dendroModel();
		const trajectory = new Trajectory(
			`conflict-${Date.now()}-${context.conflict.paths.length}f`,
			this.options.trajectoryDirectory,
		);

		trajectory.record("start", {
			description: context.description,
			conflictedPaths: context.conflict.paths,
			model: model.id,
			thinkingLevel,
		});

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(DENDRO_PROVIDER, this.options.apiKey);
		const modelRegistry = ModelRegistry.inMemory(authStorage);

		const resourceLoader = new DefaultResourceLoader({
			cwd: context.git.cwd,
			// Points at the worktree so nothing on the runner's home directory is
			// discovered; every resource kind is disabled anyway.
			agentDir: `${context.git.cwd}/.forkit-agent`,
			systemPrompt: SYSTEM_PROMPT,
			extensionFactories: [
				createResolverToolPolicy({
					root: context.git.cwd,
					conflictedPaths: context.conflict.paths,
				}),
			],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: context.git.cwd,
			model,
			thinkingLevel,
			authStorage,
			modelRegistry,
			// The name allowlist removes execution tools; the inline policy above
			// confines filesystem parameters to the worktree and conflicted edits.
			tools: ["read", "grep", "ls", "edit"],
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true },
				retry: { enabled: true, maxRetries: 3 },
			}),
		});

		let assistantText = "";
		const unsubscribe = session.subscribe((event) => {
			recordEvent(trajectory, event, (text) => {
				assistantText += text;
			});
		});

		const deadline = setTimeout(
			() => void session.abort(),
			this.options.timeoutMs ?? 10 * 60_000,
		);

		try {
			const diff3 = await context.git.diff(["--diff-filter=U"]);
			await session.prompt(
				buildPrompt({
					description: context.description,
					conflictedPaths: context.conflict.paths,
					upstreamCommits: context.upstreamCommits,
					pullRequest: context.pullRequest,
					diff3,
				}),
			);

			const summary = assistantText.trim();
			const outcome: ResolverOutcome = summary
				? { status: "resolved", summary }
				: { status: "failed", reason: "the resolver produced no explanation" };

			trajectory.record("end", { status: outcome.status });
			await trajectory.persist({
				description: context.description,
				conflictedPaths: context.conflict.paths,
				model: model.id,
				thinkingLevel,
				outcome: outcome.status,
			});

			return outcome;
		} catch (error) {
			const reason = (error as Error).message;
			trajectory.record("error", { reason });
			// Failures are the most useful transcripts to keep: a resolution that
			// worked needs no study.
			await trajectory.persist({
				description: context.description,
				conflictedPaths: context.conflict.paths,
				model: model.id,
				thinkingLevel,
				outcome: `failed: ${reason}`,
			});
			return { status: "failed", reason };
		} finally {
			clearTimeout(deadline);
			unsubscribe();
			session.dispose();
		}
	}
}

function recordEvent(trajectory: Trajectory, event: unknown, onText: (text: string) => void): void {
	if (typeof event !== "object" || event === null || !("type" in event)) return;
	const typed = event as { type: string; [key: string]: unknown };

	switch (typed.type) {
		case "message_update": {
			const inner = typed.assistantMessageEvent as { type?: string; delta?: string } | undefined;
			if (inner?.type === "text_delta" && inner.delta) onText(inner.delta);
			return;
		}
		case "tool_execution_start":
			trajectory.record("tool_execution_start", { toolName: typed.toolName, args: typed.args });
			return;
		case "tool_execution_end":
			trajectory.record("tool_execution_end", { toolName: typed.toolName, args: typed.args });
			return;
		case "agent_end": {
			const message = typed.message as { usage?: unknown; content?: unknown } | undefined;
			if (message?.usage) trajectory.record("usage", { usage: message.usage });
			trajectory.record("agent_end");
			return;
		}
		default:
			return;
	}
}
