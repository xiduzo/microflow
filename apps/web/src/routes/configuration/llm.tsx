// Reachable in both hosts: since ADR-0009 the browser performs LLM calls itself
// (direct `fetch` from the page) and resolves the provider from this store — so
// a web user who cannot open this page cannot use the Llm node at all.
//
// The page is a console: providers are a rail, and `ask` runs the very same
// transport the Llm node uses. If a prompt answers here, the node will answer.
import { createFileRoute } from "@tanstack/react-router";
import { BotIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLlmProviderStore, type LlmProviderConfig } from "@/stores/llm-provider";
import { track } from "@/lib/analytics";
import { invokeCommand } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import {
  isProbeOk,
  probeLlmProvider,
  probeStatus,
  type LlmProbeOutcome,
} from "@/session/browser-cloud-probe";
import { isMixedContent } from "@/lib/ai/endpoint";
import { fetchModels, KNOWN_MODELS, providerFamily, providerModel } from "@/lib/ai/models";
import { CLI_PROVIDERS, isCliProvider as isCli } from "@/lib/ai/cli-providers";
import { ProviderBadge } from "@/components/flow/nodes/_base/desktop-only-badge";
import {
  ConnectionConsole,
  ConsoleChip,
  ConsoleCombo,
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

const PRESETS: Array<ConsolePreset & { defaults: Omit<LlmProviderConfig, "id" | "isDefault"> }> = [
  {
    id: "ollama",
    title: "Ollama",
    blurb: "Runs on your machine. No key, no bill, desktop app only.",
    defaults: { kind: "http", name: "Ollama", baseUrl: "http://localhost:11434", apiKey: "", model: "llama3.2" },
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    blurb: "One key, hundreds of models. Works on web and desktop.",
    defaults: {
      kind: "http",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      model: "openai/gpt-4o-mini",
    },
  },
  {
    id: "openai",
    title: "OpenAI",
    blurb: "GPT models from the source. Bring your own key.",
    defaults: { kind: "http", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
  },
  // Local agent CLIs. They run as a subprocess, so they are desktop-only and
  // the list is filtered below rather than offered on the web and then failing.
  ...CLI_PROVIDERS.map((cli) => ({
    id: cli.id,
    title: cli.title,
    blurb: cli.blurb,
    defaults: {
      kind: "cli" as const,
      name: cli.title,
      baseUrl: cli.id,
      apiKey: "",
      model: cli.defaultModel,
    },
  })),
  {
    id: "custom",
    title: "Custom endpoint",
    blurb: "Anything that speaks the OpenAI API.",
    defaults: { kind: "http", name: "Custom endpoint", baseUrl: "", apiKey: "", model: "" },
  },
];

function statusTone(status: string | undefined): ConnectionStatusTone {
  if (status === "ok") return "ok";
  if (status === "testing") return "busy";
  if (status === "error") return "error";
  return "idle";
}

/** Console-only setting: a scratch system prompt for the next `ask`. The model
 *  is not here — it belongs to the configuration, so everything that uses this
 *  provider uses the same one. */
type ConsoleSettings = { system: string };

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

  // What the selected provider says it can run, asked once per provider and
  // kept for the session. Keyed by provider id rather than held as one list so
  // switching back to a provider does not re-ask, and so a slow endpoint never
  // shows its answer under a different provider.
  const [catalogue, setCatalogue] = useState<Record<string, string[]>>({});

  const provider = providers.find((entry) => entry.id === selectedId);
  const current = settings[selectedId] ?? { system: "" };
  const model = provider ? providerModel(provider) : "";

  // Ask the provider for its models when it is selected, and again whenever the
  // endpoint or key changes — those are exactly the edits that change the
  // answer. Ignores a response that lands after the user moved on.
  const endpoint = provider ? `${provider.baseUrl}|${provider.apiKey}` : "";
  useEffect(() => {
    if (!provider) return;
    let current = true;
    const { id, kind, baseUrl, apiKey } = provider;
    void fetchModels({ kind, baseUrl, apiKey }).then((models) => {
      if (current) setCatalogue((previous) => ({ ...previous, [id]: models }));
    });
    return () => {
      current = false;
    };
    // `endpoint` is the identity that matters here; `provider` is a fresh object
    // on every store write (including the model edits this must not re-run for).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, endpoint]);

  const models = catalogue[selectedId] ?? [];

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
    push({
      kind: "sys",
      text: isCli(entry) ? `looking for the ${entry.baseUrl} CLI…` : `probing ${entry.baseUrl}…`,
    });

    // One probe, both hosts (ADR-0021) — it runs over the same `hostFetch` a
    // generation does, so "reachable" here means the Llm node will answer. The
    // probe reports *why* it failed; this page only renders the sentence.
    const outcome = await probeLlmProvider(entry);
    const ok = isProbeOk(outcome);

    track("llm_provider_tested", { family: providerFamily(entry.baseUrl), ok });
    setStatus(entry.id, probeStatus(outcome));
    push(
      ok
        ? { kind: "sys", text: isCli(entry) ? "installed" : "reachable" }
        : { kind: "err", text: explainProbe(outcome, entry.baseUrl) },
    );
  };

  const ask = async (entry: LlmProviderConfig, prompt: string) => {
    push({ kind: "out", label: model, text: prompt });
    setStatus(entry.id, "testing");
    try {
      // Loaded on demand: this console is the only reason a user who never
      // places an Llm node would need the transport, and they reached it by
      // typing `ask`.
      const { performLlmGenerate } = await import("@/lib/firmata/cloud/llm-client");
      const text = await performLlmGenerate(
        { kind: entry.kind, baseUrl: entry.baseUrl, apiKey: entry.apiKey },
        { model, system: current.system || null, prompt },
      );
      setStatus(entry.id, "ok");
      push({ kind: "in", label: model, text });
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
        if (parsed.rest === "") return push({ kind: "sys", text: `model is ${model}` });
        updateProvider(provider.id, { model: parsed.rest });
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
    // The live catalogue first, the hardcoded guess only to keep completions
    // useful while a listing is still in flight or the endpoint is down.
    const options = [
      ...new Set([
        model,
        ...models,
        ...(KNOWN_MODELS[providerFamily(provider?.baseUrl ?? "")] ?? []),
      ]),
    ].filter(Boolean);
    return COMMANDS.map((command) =>
      command.name === "model" ? { ...command, values: () => options } : command,
    );
  }, [model, models, provider?.baseUrl]);

  const add = (presetId?: string) => {
    const preset =
      PRESETS.find((entry) => entry.id === presetId) ?? PRESETS[PRESETS.length - 1];
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
        subtitle: isCli(entry) ? `${entry.baseUrl} · local CLI` : entry.baseUrl,
        badge: <ProviderBadge provider={entry} surface="config" />,
        isDefault: entry.isDefault,
        status: statusTone(statuses[entry.id]),
      }))}
      selectedId={selectedId}
      onSelect={select}
      addLabel="provider"
      presets={PRESETS.map(({ id, title, blurb, defaults }) => ({
        id,
        title,
        blurb,
        badge: <ProviderBadge provider={defaults} surface="config" />,
      }))}
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
            <ConsoleChip>model: {model}</ConsoleChip>
            {current.system && (
              <ConsoleChip onRemove={() => patch({ system: "" })} removeLabel="Clear system prompt">
                system prompt
              </ConsoleChip>
            )}
            {isCli(provider) ? (
              <ConsoleChip>local CLI</ConsoleChip>
            ) : (
              !provider.apiKey &&
              providerFamily(provider.baseUrl) !== "ollama" && <ConsoleChip>no API key</ConsoleChip>
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
            {isCli(provider) ? (
              <ConsoleField
                label="CLI"
                value={provider.baseUrl}
                readOnly
                hint="Runs the CLI installed on this machine, signed in as you — no endpoint and no API key. Its own tools stay out of your flow; it only answers."
              />
            ) : (
              <>
                <ConsoleField
                  label="Base URL"
                  value={provider.baseUrl}
                  placeholder="http://localhost:11434"
                  tone={isMixedContent(provider.baseUrl) ? "warning" : undefined}
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
              </>
            )}
            <ConsoleCombo
              label="Model"
              // Bound to what is *stored*, not to `model` — which is the
              // resolved value and falls back when the field is empty. An empty
              // store value is a real choice (a CLI runs its own default), so
              // the combo offers it back as "use the default" rather than
              // writing the resolved name in as if the user had picked it.
              value={provider.model ?? ""}
              options={models}
              fallback={model || "the CLI's own default"}
              placeholder={isCli(provider) ? (model ?? "the CLI's own default") : model}
              hint={
                models.length > 0
                  ? `Used by ask here and by Ask AI. Each Llm node still picks its own. ${models.length} available, or type any other.`
                  : "Used by ask here and by Ask AI. Each Llm node still picks its own."
              }
              onValueChange={(next) => updateProvider(provider.id, { model: next })}
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
  return isMixedContent(baseUrl)
    ? "This page is served over https, so the browser blocks calls to an http:// endpoint entirely (mixed content). Use https, or the desktop app — for a local Ollama, the desktop app is the only option."
    : `Called directly from this page: the endpoint must allow CORS requests from ${window.location.origin}. The desktop app has no such restriction.`;
}

/**
 * The sentence for one probe outcome. One switch over what the probe actually
 * saw, so this page authors no predicate about *why* a probe failed — a 401 can
 * no longer be reported as a CORS problem.
 */
function explainProbe(outcome: LlmProbeOutcome, baseUrl: string): string {
  switch (outcome.kind) {
    case "ok":
      return "";
    case "cliNotFound":
      return isDesktop()
        ? `${outcome.bin} was not found on this machine — install it, or check it is on your PATH.`
        : `${outcome.bin} runs as a program on your computer, which a browser tab cannot start. Use Microflow Studio, the desktop app.`;
    case "mixedContent":
      return `${baseUrl} is an http:// endpoint and this page is served over https, so the browser blocked the request before it was sent. Use https, or the desktop app.`;
    case "httpError":
      // It answered, so reaching it is not the problem.
      return outcome.status === 401 || outcome.status === 403
        ? `${baseUrl} answered ${outcome.status} — check the API key.`
        : `${baseUrl} answered ${outcome.status} — check the URL points at the API root.`;
    case "unreachable":
      // The desktop app fetches through Tauri's HTTP plugin, so CORS never
      // applies — saying it does sent users chasing an origin that was never
      // the problem.
      return isDesktop()
        ? `${baseUrl} did not answer — check that it is running and the URL is right.`
        : `${baseUrl} is not reachable from this page — check that it is running and allows CORS from ${window.location.origin}.`;
  }
}
