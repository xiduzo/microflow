// Reachable in both hosts: since ADR-0009 the browser performs LLM calls itself
// (direct `fetch` from the page) and resolves the provider from this store — so
// a web user who cannot open this page cannot use the Llm node at all.
//
// The page is a console: providers are a rail, and `ask` runs the very same
// transport the Llm node uses. If a prompt answers here, the node will answer.
import { createFileRoute } from "@tanstack/react-router";
import { BotIcon, MessageSquareIcon, PlusIcon } from "lucide-react";

import { useLlmProviderStore, type LlmProviderConfig } from "@/ai/llm-provider";
import { isDesktop } from "@/platform/platform";
import { isMixedContent } from "@/ai/endpoint";
import { providerFamily, providerModel } from "@/ai/models";
import { CLI_PROVIDERS, isCliProvider as isCli } from "@/ai/cli-providers";
import { ProviderBadge } from "@/nodes/_base/desktop-only-badge";
import {
  ConnectionConsole,
  ConsoleChip,
  ConsoleCombo,
  ConsoleField,
  type ConnectionStatusTone,
  type ConsolePreset,
} from "@/cloud/connection-console/connection-console";
import { useLlmConsole } from "@/cloud/connection-console/use-console-session";
import { EmptyState } from "@/ui/states/empty-state";
import { Button } from "@/ui/button";

export const Route = createFileRoute("/configuration/llm")({
  component: LlmConfigPage,
});

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

function LlmConfigPage() {
  const providers = useLlmProviderStore((state) => state.providers);
  const statuses = useLlmProviderStore((state) => state.statuses);
  const addProvider = useLlmProviderStore((state) => state.addProvider);
  const updateProvider = useLlmProviderStore((state) => state.updateProvider);
  const deleteProvider = useLlmProviderStore((state) => state.deleteProvider);
  const setDefaultProvider = useLlmProviderStore((state) => state.setDefaultProvider);

  const [{ selectedId, lines, commands, system, models }, session] = useLlmConsole();
  const provider = providers.find((entry) => entry.id === selectedId);
  const model = provider ? providerModel(provider) : "";

  const add = (presetId?: string) => {
    const preset =
      PRESETS.find((entry) => entry.id === presetId) ?? PRESETS[PRESETS.length - 1];
    session.select(addProvider({ ...preset.defaults, isDefault: providers.length === 0 }));
    // A preset arrives with its endpoint filled in, so it counts as added now.
    session.reportConfigured();
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
      onSelect={session.select}
      addLabel="provider"
      presets={PRESETS.map(({ id, title, blurb, defaults }) => ({
        id,
        title,
        blurb,
        badge: <ProviderBadge provider={defaults} surface="config" />,
      }))}
      onAdd={add}
      lines={lines}
      onClear={() => session.run("clear")}
      commands={commands}
      onRun={session.run}
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
            {system && (
              <ConsoleChip onRemove={() => session.setSystemPrompt("")} removeLabel="Clear system prompt">
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
                  onBlur={session.reportConfigured}
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
              value={system}
              placeholder="optional"
              onChange={(event) => session.setSystemPrompt(event.target.value)}
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
                onClick={() => session.run("test")}
              >
                test
              </button>
              <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-destructive"
                onClick={() => deleteProvider(provider.id)}
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
