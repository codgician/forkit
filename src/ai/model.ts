import type { Model } from "@mariozechner/pi-ai";

/**
 * The model forkit resolves conflicts with, served through a LiteLLM proxy.
 *
 * `compat` is set explicitly rather than left to pi's auto-detection: pi infers
 * OpenAI-compatibility flags from the base URL, and a private proxy hostname
 * matches none of its known patterns, so it would otherwise guess.
 */
export const DENDRO_PROVIDER = "dendro";

export function dendroModel(): Model<"openai-completions"> {
	return {
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna (dendro)",
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
