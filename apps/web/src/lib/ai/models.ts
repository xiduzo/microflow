// Which model an endpoint is likely to have, from its URL alone.
//
// Providers do not agree on a listing API (only Ollama exposes `/api/tags`), so
// a first sensible model is guessed and then owned by the LLM configuration.
// Shared by the configuration page and Ask AI so both mean the same thing by
// "the model for this provider".

import { cliProvider } from "./cli-providers";
import { hostFetch, normalizeBaseUrl } from "./endpoint";

/** Coarse provider family from the base URL. Also used for analytics, where it
 *  keeps cardinality low and never reveals a user's private endpoint. */
export function providerFamily(baseUrl: string): string {
  // Local CLI providers store the CLI's id where an HTTP one stores a URL, and
  // those ids ("claude", "opencode", "pi") are never a URL — so the family is
  // readable from the same field with no extra argument at every call site.
  if (cliProvider(baseUrl)) return baseUrl;

  const url = baseUrl.toLowerCase();
  if (url.includes("localhost:11434") || url.includes("ollama")) return "ollama";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.openai.com")) return "openai";
  return "other";
}

/** Models worth offering as completions per family. The first is the default. */
export const KNOWN_MODELS: Record<string, string[]> = {
  // Local CLIs: aliases each one resolves itself. An empty entry means "use
  // whatever that CLI is already configured for", which is the right default
  // for a tool the user set up on purpose.
  claude: ["sonnet", "opus", "haiku"],
  // `auto` is Copilot's own documented "you pick" value, and the only name that
  // is stable across its model lineup.
  copilot: ["auto"],
  // Left empty deliberately for the rest: they have no listing subcommand and
  // no stable aliases, so a guess here would age into a model name that no
  // longer resolves. Empty means "whatever that CLI is configured for", and the
  // Model field still takes anything typed into it.
  codex: [],
  gemini: [],
  opencode: [],
  pi: [],
  ollama: ["llama3.2", "llama3.1", "mistral", "qwen2.5", "phi3"],
  openrouter: [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-flash-1.5",
    "meta-llama/llama-3.1-70b-instruct",
  ],
  openai: ["gpt-4o-mini", "gpt-4o", "o3-mini"],
  other: [],
};

/** The model a provider talks to. Falls back by family so a configuration saved
 *  before models were part of one still answers. */
export function providerModel(provider: { model?: string; baseUrl: string }): string {
  if (provider.model) return provider.model;
  // A CLI with no model set is not misconfigured — it falls back to its own
  // default, so do not invent one (and never an OpenAI name it cannot resolve).
  const cli = cliProvider(provider.baseUrl);
  if (cli) return cli.defaultModel;
  return KNOWN_MODELS[providerFamily(provider.baseUrl)]?.[0] || "gpt-4o-mini";
}

/** How long to wait for a listing. Same budget as the reachability probe — this
 *  runs on the same endpoint, and a provider that cannot answer in 8s is one the
 *  user needs told about, not one to keep a spinner up for. */
const LIST_TIMEOUT_MS = 8000;

/**
 * The models a provider actually offers, asked rather than guessed.
 *
 * `KNOWN_MODELS` is a hardcoded guess that ages badly and cannot know what the
 * user pulled locally; this is the real list. Both still matter — the guess is
 * the fallback when a provider has no listing (Claude Code) or cannot be
 * reached, so the dropdown is never empty.
 *
 * For an HTTP provider this is `GET /models`, the OpenAI-compatible endpoint
 * that Ollama, OpenRouter, LM Studio and vLLM all answer — and the same one the
 * reachability probe hits, so a green dot implies a populated dropdown. For a
 * CLI it is that CLI's own listing subcommand.
 *
 * Never throws: an unreachable provider yields the fallback, because a failed
 * listing must not break the settings pane the user is typing in.
 */
export async function fetchModels(
  provider: { kind?: string; baseUrl: string; apiKey?: string },
  /** Test seam, matching `probeLlmProvider`: the host `fetch` otherwise. */
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  const fallback = KNOWN_MODELS[providerFamily(provider.baseUrl)] ?? [];

  try {
    const models =
      provider.kind === "cli"
        ? await listCliModels(provider.baseUrl)
        : await listHttpModels(provider, fetchImpl);
    return models.length > 0 ? models : fallback;
  } catch {
    return fallback;
  }
}

async function listHttpModels(
  provider: { baseUrl: string; apiKey?: string },
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  const doFetch = fetchImpl ?? (await hostFetch());
  const response = await doFetch(`${normalizeBaseUrl(provider.baseUrl)}/models`, {
    headers,
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!response.ok) return [];

  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? [])
    .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
    .filter(Boolean)
    .sort();
}

async function listCliModels(id: string): Promise<string[]> {
  const cli = cliProvider(id);
  if (!cli?.listModels) return [];

  const { invokeCommand } = await import("@/lib/ipc");
  const response = await invokeCommand<
    { type: "llm_cli_models"; bin: string; args: string[] },
    Record<string, unknown>
  >({ type: "llm_cli_models", bin: id, args: cli.listModels.args });

  if (!response.success) return [];
  return cli.listModels.parse(String(response.data ?? ""));
}
