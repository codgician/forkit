import type { Model, ThinkingLevel } from "@mariozechner/pi-ai";

export const DENDRO_PROVIDER = "dendro";

/**
 * The single declaration of which model resolves conflicts, how hard it
 * thinks, and how long it may take. Change the resolver's model here only.
 *
 * `xhigh` is model-specific and passes through a proxy that may not forward
 * it; the reasoning tokens recorded in each trajectory confirm it took effect.
 */
export const RESOLVER_MODEL: {
	readonly id: string;
	readonly name: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly timeoutMs: number;
} = {
	id: "gpt-6-luna",
	name: "GPT-6 Luna (dendro)",
	thinkingLevel: "xhigh",
	timeoutMs: 60 * 60_000,
};

/**
 * The resolver model, served through a LiteLLM proxy.
 *
 * `compat` is set explicitly rather than left to pi's auto-detection: pi infers
 * OpenAI-compatibility flags from the base URL, and a private proxy hostname
 * matches none of its known patterns, so it would otherwise guess.
 */
export function dendroModel(): Model<"openai-completions"> {
	return {
		id: RESOLVER_MODEL.id,
		name: RESOLVER_MODEL.name,
		api: "openai-completions",
		provider: DENDRO_PROVIDER,
		baseUrl: process.env.DENDRO_BASE_URL ?? "https://dendro.codgician.me/v1",
		reasoning: true,
		input: ["text"],
		// Only used for display; the proxy owns real accounting.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 64_000,
		compat: {
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			maxTokensField: "max_completion_tokens",
			supportsDeveloperRole: false,
		},
	};
}
