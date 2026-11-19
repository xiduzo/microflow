/**
 * The Connection Console session for LLM providers: what `ask`, `model`,
 * `system` and `test` do, the sentence for every way a probe can fail, and the
 * list of models each provider says it can run.
 *
 * There is no transport seam here. Since ADR-0021 there is one LLM transport,
 * performed by the webview in both hosts, so the session calls it: `ask` is the
 * very call an `Llm` node makes and `test` is the one reachability probe. If a
 * prompt answers here, the node will answer. Providers themselves are read
 * from, and `model` writes to, `useLlmProviderStore`.
 */
import { isCliProvider } from "@/ai/cli-providers";
import { settleLlmProviders, useLlmProviderStore, type LlmProviderConfig } from "@/ai/llm-provider";
import { fetchModels, KNOWN_MODELS, providerFamily, providerModel } from "@/ai/models";
import {
  isProbeOk,
  probeLlmProvider,
  probeStatus,
  type LlmProbeOutcome,
} from "@/cloud/browser-cloud-probe";
import { track as trackEvent } from "@/lib/analytics";

import type { ConsoleCommand } from "./completions";
import {
  createTranscript,
  restAfter,
  type ConsoleSession,
  type Reply,
} from "./console-session";

type LlmConsoleExtra = {
  /**
   * A scratch system prompt for the selected provider's next `ask`. The model
   * is not here — it belongs to the configuration, so everything that uses the
   * provider uses the same one.
   */
  system: string;
  /** What the selected provider says it can run. Empty until it has answered. */
  models: string[];
};

export type LlmConsoleSession = ConsoleSession<LlmConsoleExtra> & {
  /** Set the selected provider's system prompt, or clear it with an empty string. */
  setSystemPrompt(text: string): void;
};

/** Where the page runs. It decides what a failed probe can be blamed on. */
export type LlmConsoleHost = {
  desktop: boolean;
  /** The page's origin: what an endpoint has to allow for a browser to call it. */
  origin: string;
};

const COMMANDS: ConsoleCommand[] = [
  { name: "ask", args: "<prompt>", help: "Send a prompt. Plain text works too.", insert: "ask " },
  { name: "model", args: "<name>", help: "Set the model ask uses, e.g. llama3.2", insert: "model " },
  { name: "system", args: "<text>", help: "Set a system prompt, or clear it with no text", insert: "system " },
  { name: "test", help: "Check the endpoint is reachable", insert: "test" },
  { name: "clear", help: "Empty the transcript", insert: "clear" },
  { name: "?", help: "List every command", insert: "?" },
];

export function createLlmConsoleSession(options: {
  host: LlmConsoleHost;
  /** Where analytics events go. */
  track?: typeof trackEvent;
}): LlmConsoleSession {
  const { host, track = trackEvent } = options;
  const store = () => useLlmProviderStore.getState();
  const providers = () => store().providers;

  /** System prompt per provider id, kept while the session lives. */
  const systems: Record<string, string> = {};
  /**
   * Models per provider id, kept while the session lives. Keyed by provider
   * rather than held as one list, so switching back shows the last answer at
   * once and a slow endpoint never shows its answer under another provider.
   */
  const catalogue: Record<string, string[]> = {};
  const extraFor = (id: string): LlmConsoleExtra => ({
    system: systems[id] ?? "",
    models: catalogue[id] ?? [],
  });

  const initialId = providers().find((provider) => provider.isDefault)?.id ?? providers()[0]?.id ?? "";

  const transcript = createTranscript<LlmConsoleExtra>({
    selectedId: initialId,
    extra: extraFor(initialId),
    vocabulary: COMMANDS,
    commands: (state) => {
      // The live catalogue first, the hardcoded guess only to keep completions
      // useful while a listing is still in flight or the endpoint is down.
      const options = () => {
        const provider = providers().find((entry) => entry.id === state.selectedId);
        return [
          ...new Set([
            provider ? providerModel(provider) : "",
            ...state.models,
            ...(KNOWN_MODELS[providerFamily(provider?.baseUrl ?? "")] ?? []),
          ]),
        ].filter(Boolean);
      };
      return COMMANDS.map((command) =>
        command.name === "model" ? { ...command, values: options } : command,
      );
    },
  });

  const selected = () => providers().find((entry) => entry.id === transcript.getState().selectedId);

  let live = false;
  /** The provider, endpoint and key the catalogue was last asked for. */
  let listed = "";

  /**
   * Ask the selected provider for its models when it is selected, and again
   * whenever its endpoint or key changes — those are exactly the edits that
   * change the answer — once the change settled: a key that is being typed is
   * not sent a keystroke at a time. Ignores an answer that lands after the user
   * moved on.
   */
  const list = () => {
    const { selectedId } = transcript.getState();
    const provider = live ? store().settled.find((entry) => entry.id === selectedId) : undefined;
    const target = provider ? `${provider.id}\n${provider.baseUrl}\n${provider.apiKey}` : "";
    if (target === listed) return;
    listed = target;
    if (!provider) return;
    const { id, kind, baseUrl, apiKey } = provider;
    void fetchModels({ kind, baseUrl, apiKey }).then((models) => {
      if (listed !== target) return;
      catalogue[id] = models;
      transcript.update({ models });
    });
  };

  const select = (id: string) => {
    if (id === transcript.getState().selectedId) return;
    transcript.select(id, extraFor(id));
    list();
  };

  let seen = selected();
  const followStore = () => {
    const { selectedId } = transcript.getState();
    const provider = selected();
    // A deleted provider cannot stay selected: move to the first one left.
    if (selectedId !== "" && !provider) return select(providers()[0]?.id ?? "");
    list();
    // The model completions read the stored configuration, so an edit to it is
    // a change to the commands.
    if (provider !== seen) {
      seen = provider;
      transcript.update({});
    }
  };

  // `test` and `ask` are answered later, possibly after the user has switched
  // provider. The status is the provider's and is always settled; the lines go
  // through `reply`, which drops them once the transcript is another's.

  const test = async (entry: LlmProviderConfig, reply: Reply) => {
    store().setStatus(entry.id, "testing");
    reply.push({
      kind: "sys",
      text: isCliProvider(entry) ? `looking for the ${entry.baseUrl} CLI…` : `probing ${entry.baseUrl}…`,
    });

    // One probe, both hosts (ADR-0021) — it runs over the same `hostFetch` a
    // generation does, so "reachable" here means the Llm node will answer. The
    // probe reports *why* it failed; the session only words it.
    const outcome = await probeLlmProvider(entry);
    const ok = isProbeOk(outcome);

    track("llm_provider_tested", { family: providerFamily(entry.baseUrl), ok });
    store().setStatus(entry.id, probeStatus(outcome));
    reply.push(
      ok
        ? { kind: "sys", text: isCliProvider(entry) ? "installed" : "reachable" }
        : { kind: "err", text: explainProbe(outcome, entry.baseUrl, host) },
    );
  };

  const ask = async (entry: LlmProviderConfig, prompt: string, reply: Reply) => {
    const model = providerModel(entry);
    const { system } = transcript.getState();
    reply.push({ kind: "out", label: model, text: prompt });
    store().setStatus(entry.id, "testing");
    try {
      // Loaded on demand: this console is the only reason a user who never
      // places an Llm node would need the transport, and they reached it by
      // typing `ask`.
      const { performLlmGenerate } = await import("@/ai/llm-client");
      const text = await performLlmGenerate(
        { kind: entry.kind, baseUrl: entry.baseUrl, apiKey: entry.apiKey },
        { model, system: system || null, prompt },
      );
      store().setStatus(entry.id, "ok");
      reply.push({ kind: "in", label: model, text });
    } catch (error) {
      store().setStatus(entry.id, "error");
      reply.push({ kind: "err", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const setSystemPrompt = (text: string) => {
    systems[transcript.getState().selectedId] = text;
    transcript.update({ system: text });
  };

  return {
    getState: transcript.getState,
    subscribe: transcript.subscribe,

    open() {
      live = true;
      list();
      const unfollow = useLlmProviderStore.subscribe(followStore);
      return () => {
        unfollow();
        live = false;
        list();
      };
    },

    select,
    setSystemPrompt,

    run: (input) =>
      transcript.run(input, (parsed, reply) => {
        // A command acts on the settings the form shows.
        settleLlmProviders();
        const provider = selected();
        if (!provider) return;

        switch (parsed.verb) {
          case "ask": {
            const prompt = restAfter(parsed, 0);
            if (prompt === "") {
              return transcript.push({
                kind: "err",
                text: "ask needs a prompt — try: ask why is the sky blue",
              });
            }
            return ask(provider, prompt, reply);
          }
          case "model":
            if (parsed.rest === "") {
              return transcript.push({ kind: "sys", text: `model is ${providerModel(provider)}` });
            }
            store().updateProvider(provider.id, { model: parsed.rest });
            return transcript.push({ kind: "sys", text: `model set to ${parsed.rest}` });
          case "system":
            setSystemPrompt(parsed.rest);
            return transcript.push({
              kind: "sys",
              text: parsed.rest ? "system prompt set" : "system prompt cleared",
            });
          case "test":
            return test(provider, reply);
          default:
            // Anything else is almost certainly a prompt; nobody should have to
            // type "ask" to talk to a model.
            return ask(provider, parsed.raw, reply);
        }
      }),

    reportConfigured() {
      const provider = selected();
      if (!provider || provider.baseUrl.trim() === "") return;
      transcript.reportOnce(provider.id, () =>
        track("llm_provider_added", {
          family: providerFamily(provider.baseUrl),
          keyed: Boolean(provider.apiKey),
        }),
      );
    },
  };
}

/**
 * The sentence for one probe outcome. One switch over what the probe actually
 * saw, so the session authors no predicate about *why* a probe failed — a 401
 * is never reported as a CORS problem.
 */
function explainProbe(outcome: LlmProbeOutcome, baseUrl: string, host: LlmConsoleHost): string {
  switch (outcome.kind) {
    case "ok":
      return "";
    case "cliNotFound":
      return host.desktop
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
      // applies — saying it does would send users chasing an origin that is
      // not the problem.
      return host.desktop
        ? `${baseUrl} did not answer — check that it is running and the URL is right.`
        : `${baseUrl} is not reachable from this page — check that it is running and allows CORS from ${host.origin}.`;
  }
}
