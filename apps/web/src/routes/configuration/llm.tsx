// Reachable in both hosts: since ADR-0009 the browser performs LLM calls itself
// (direct `fetch` from the page) and resolves the provider from this store — so
// a web user who cannot open this page cannot use the Llm node at all.
//
// The page is a console: providers are a rail, and `ask` runs the very same
// transport the Llm node uses. If a prompt answers here, the node will answer.
import { createFileRoute } from "@tanstack/react-router";
import { BotIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useLlmProviderStore, type LlmProviderConfig } from "@/stores/llm-provider";
import { track } from "@/lib/analytics";
import { invokeCommand } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import { probeLlmProvider } from "@/session/browser-cloud-probe";
import { performLlmGenerate } from "@/lib/firmata/cloud/llm-client";
import {
  ConnectionConsole,
  ConsoleChip,
  ConsoleField,
  appendLine,
  type ConnectionStatusTone,
  type ConsoleCommand,
  type ConsoleLine,
  type ConsolePreset,
} from "@/components/config/connection-console";
import { parseCommand, restAfter } from "@/components/config/parse-command";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/configuration/llm")({
  component: LlmConfigPage,
});

const COMMANDS: ConsoleCommand[] = [
  { name: "ask", args: "<prompt>", help: "Send a prompt. Plain text works too.", insert: "ask " },
  { name: "model", args: "<name>", help: "Set the model ask uses, e.g. llama3.2", insert: "model " },
  { name: "system", args: "<text>", help: "Set a system prompt, or clear it with no text", insert: "system " },
  { name: "test", help: "Check the endpoint is reachable", insert: "test" },
  { name: "clear", help: "Empty the transcript", insert: "clear" },
  { name: "?", help: "List every command", insert: "?" },
];

const PRESETS: Array<ConsolePreset & { defaults: { name: string; baseUrl: string; apiKey: string } }> = [
  {
    id: "ollama",
    title: "Ollama",
    blurb: "Runs on your machine. No key, no bill, desktop app only.",
    defaults: { name: "Ollama", baseUrl: "http://localhost:11434", apiKey: "" },
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    blurb: "One key, hundreds of models. Works on web and desktop.",
    defaults: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "" },
  },
  {
    id: "openai",
    title: "OpenAI",
    blurb: "GPT models from the source. Bring your own key.",
    defaults: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "" },
  },
  {
    id: "custom",
    title: "Custom endpoint",
    blurb: "Anything that speaks the OpenAI API.",
    defaults: { name: "Custom endpoint", baseUrl: "", apiKey: "" },
  },
];

/** An `http://` endpoint on an `https://` page: blocked by the browser before
 *  any request goes out, and unfixable from our side. */
function mixedContent(baseUrl: string): boolean {
  return (
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    baseUrl.trim().toLowerCase().startsWith("http://")
  );
}

// Coarse provider family from the base URL — keeps analytics low-cardinality
// (never the URL itself, which can identify a user's private endpoint).
function providerFamily(baseUrl: string): string {
  const url = baseUrl.toLowerCase();
  if (url.includes("localhost:11434") || url.includes("ollama")) return "ollama";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.openai.com")) return "openai";
  return "other";
}

/** Models worth offering as completions per family. The first is the default. */
const KNOWN_MODELS: Record<string, string[]> = {
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

/** A sane first model per family, so `ask` works without a `model` command. */
function defaultModel(baseUrl: string): string {
  return KNOWN_MODELS[providerFamily(baseUrl)]?.[0] ?? "gpt-4o-mini";
}

function statusTone(status: string | undefined): ConnectionStatusTone {
  if (status === "ok") return "ok";
  if (status === "testing") return "busy";
  if (status === "error") return "error";
  return "idle";
}

/** Console-only settings: the Llm node carries its own model, so these are not
 *  worth persisting — they exist to make the next `ask` do what you meant. */
type ConsoleSettings = { model: string; system: string };

function LlmConfigPage() {
  const providers = useLlmProviderStore((state) => state.providers);
  const statuses = useLlmProviderStore((state) => state.statuses);
  const addProvider = useLlmProviderStore((state) => state.addProvider);
  const updateProvider = useLlmProviderStore((state) => state.updateProvider);
  const deleteProvider = useLlmProviderStore((state) => state.deleteProvider);
  const setDefaultProvider = useLlmProviderStore((state) => state.setDefaultProvider);
  const setStatus = useLlmProviderStore((state) => state.setStatus);

  const [selectedId, setSelectedId] = useState(
    () => providers.find((provider) => provider.isDefault)?.id ?? providers[0]?.id ?? "",
  );
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [settings, setSettings] = useState<Record<string, ConsoleSettings>>({});

  const provider = providers.find((entry) => entry.id === selectedId);
  const current = settings[selectedId] ?? { model: defaultModel(provider?.baseUrl ?? ""), system: "" };

  const push = (line: Omit<ConsoleLine, "at">) => setLines((previous) => appendLine(previous, line));
  const patch = (values: Partial<ConsoleSettings>) =>
    setSettings((previous) => ({ ...previous, [selectedId]: { ...current, ...values } }));

  // Added blank, configured in place — so "added" fires once a URL exists.
  const tracked = useRef(new Set<string>());
  const trackConfigured = (entry: LlmProviderConfig) => {
    if (entry.baseUrl.trim() === "" || tracked.current.has(entry.id)) return;
    tracked.current.add(entry.id);
    track("llm_provider_added", {
      family: providerFamily(entry.baseUrl),
      keyed: Boolean(entry.apiKey),
    });
  };

  const select = (id: string) => {
    setSelectedId(id);
    setLines([]);
  };

  const test = async (entry: LlmProviderConfig) => {
    setStatus(entry.id, "testing");
    push({ kind: "sys", text: `probing ${entry.baseUrl}…` });

    // Desktop tests through the native host's HTTP client; the browser calls the
    // endpoint itself, which is also the only way to see its browser-only
    // blockers (mixed content, CORS).
    const result = isDesktop()
      ? await invokeCommand({ type: "llm_test_provider", baseUrl: entry.baseUrl, apiKey: entry.apiKey })
      : { success: (await probeLlmProvider(entry)) === "ok", error: browserBlocker(entry.baseUrl) };

    track("llm_provider_tested", { family: providerFamily(entry.baseUrl), ok: result.success });
    setStatus(entry.id, result.success ? "ok" : "error");
    push(
      result.success
        ? { kind: "sys", text: "reachable" }
        : { kind: "err", text: (result as { error: string }).error },
    );
  };

  const ask = async (entry: LlmProviderConfig, prompt: string) => {
    push({ kind: "out", label: current.model, text: prompt });
    setStatus(entry.id, "testing");
    try {
      const text = await performLlmGenerate(
        { baseUrl: entry.baseUrl, apiKey: entry.apiKey },
        { model: current.model, system: current.system || null, prompt },
      );
      setStatus(entry.id, "ok");
      push({ kind: "in", label: current.model, text });
    } catch (error) {
      setStatus(entry.id, "error");
      push({ kind: "err", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const run = async (input: string) => {
    if (!provider) return;
    const parsed = parseCommand(input);

    switch (parsed.verb) {
      case "ask": {
        const prompt = restAfter(parsed, 0);
        if (prompt === "") return push({ kind: "err", text: "ask needs a prompt — try: ask why is the sky blue" });
        return ask(provider, prompt);
      }
      case "model":
        if (parsed.rest === "") return push({ kind: "sys", text: `model is ${current.model}` });
        patch({ model: parsed.rest });
        return push({ kind: "sys", text: `model set to ${parsed.rest}` });
      case "system":
        patch({ system: parsed.rest });
        return push({ kind: "sys", text: parsed.rest ? "system prompt set" : "system prompt cleared" });
      case "test":
        return test(provider);
      case "clear":
        return setLines([]);
      case "?":
      case "help":
        return push({ kind: "sys", text: "", table: commands });
      default:
        // Anything else is almost certainly a prompt; nobody should have to
        // type "ask" to talk to a model.
        return ask(provider, input.trim());
    }
  };

  const commands = useMemo<ConsoleCommand[]>(() => {
    const models = [
      ...new Set([current.model, ...(KNOWN_MODELS[providerFamily(provider?.baseUrl ?? "")] ?? [])]),
    ];
    return COMMANDS.map((command) =>
      command.name === "model" ? { ...command, values: () => models } : command,
    );
  }, [current.model, provider?.baseUrl]);

  const add = (presetId?: string) => {
    const preset = PRESETS.find((entry) => entry.id === presetId) ?? PRESETS[PRESETS.length - 1];
    const id = addProvider({ ...preset.defaults, isDefault: providers.length === 0 });
    if (preset.defaults.baseUrl !== "") {
      tracked.current.add(id);
      track("llm_provider_added", { family: providerFamily(preset.defaults.baseUrl), keyed: false });
    }
    select(id);
  };

  return (
    <ConnectionConsole
      title="llm"
      connections={providers.map((entry) => ({
        id: entry.id,
        name: entry.name,
        subtitle: entry.baseUrl,
        isDefault: entry.isDefault,
        status: statusTone(statuses[entry.id]),
      }))}
      selectedId={selectedId}
      onSelect={select}
      addLabel="provider"
      presets={PRESETS.map(({ id, title, blurb }) => ({ id, title, blurb }))}
      onAdd={add}
      lines={lines}
      onClear={() => setLines([])}
      commands={commands}
      onRun={run}
      placeholder="ask why is the sky blue"
      emptyState={
        providers.length === 0 ? (
          <EmptyState
            icon={BotIcon}
            title="No providers yet"
            description="Add a provider to talk to a model from here — and from your flows."
          >
            <Button size="sm" onClick={() => add("ollama")}>
              <PlusIcon /> Start with Ollama
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={MessageSquareIcon}
            title="Nothing asked yet"
            description="Type a prompt and hit enter — this is the same call an Llm node makes."
          >
            <code className="text-[11px] text-muted-foreground">
              why is the sky blue? · test
            </code>
          </EmptyState>
        )
      }
      chips={
        provider ? (
          <>
            <ConsoleChip>model: {current.model}</ConsoleChip>
            {current.system && (
              <ConsoleChip onRemove={() => patch({ system: "" })} removeLabel="Clear system prompt">
                system prompt
              </ConsoleChip>
            )}
            {!provider.apiKey && providerFamily(provider.baseUrl) !== "ollama" && (
              <ConsoleChip>no API key</ConsoleChip>
            )}
          </>
        ) : null
      }
      detail={
        provider && (
          <>
            <ConsoleField
              label="Name"
              value={provider.name}
              onChange={(event) => updateProvider(provider.id, { name: event.target.value })}
            />
            <ConsoleField
              label="Base URL"
              value={provider.baseUrl}
              placeholder="http://localhost:11434"
              tone={mixedContent(provider.baseUrl) ? "warning" : undefined}
              hint={isDesktop() ? undefined : browserHint(provider.baseUrl)}
              onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
              onBlur={() => trackConfigured(provider)}
            />
            <ConsoleField
              label="API key"
              type="password"
              value={provider.apiKey}
              placeholder="sk-…"
              onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
            />
            <ConsoleField
              label="Model"
              value={current.model}
              hint="Used by ask on this page. Each Llm node picks its own."
              onChange={(event) => patch({ model: event.target.value })}
            />
            <ConsoleField
              label="System prompt"
              value={current.system}
              placeholder="optional"
              onChange={(event) => patch({ system: event.target.value })}
            />
            <div className="flex items-center gap-3 pt-1 text-[11px]">
              {provider.isDefault ? (
                <span className="text-accent">default provider</span>
              ) : (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setDefaultProvider(provider.id)}
                >
                  make default
                </button>
              )}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => test(provider)}
              >
                test
              </button>
              <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-destructive"
                onClick={() => {
                  deleteProvider(provider.id);
                  select(providers.find((entry) => entry.id !== provider.id)?.id ?? "");
                }}
              >
                delete
              </button>
            </div>
          </>
        )
      }
    />
  );
}

/** What the browser will refuse to do, said before it refuses. */
function browserHint(baseUrl: string): string {
  return mixedContent(baseUrl)
    ? "This page is served over https, so the browser blocks calls to an http:// endpoint entirely (mixed content). Use https, or the desktop app — for a local Ollama, the desktop app is the only option."
    : `Called directly from this page: the endpoint must allow CORS requests from ${window.location.origin}. The desktop app has no such restriction.`;
}

function browserBlocker(baseUrl: string): string {
  return `${baseUrl} is not reachable from this page — check that it allows CORS from ${window.location.origin}${
    mixedContent(baseUrl) ? ", and note that an http:// endpoint is blocked on an https page" : ""
  }.`;
}
