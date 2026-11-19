// The LLM console, driven the way the page drives it: a command string goes in,
// and what comes out is a request to the provider and a transcript line.
//
// There is one LLM transport (ADR-0021) and the session calls it, so `fetch` is
// stubbed rather than the transport — the same boundary `llm-client.test.ts`
// stubs. What the session adds on top is what is asserted here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetHostFetch } from "@/ai/endpoint";
import { settleLlmProviders, useLlmProviderStore, type LlmProviderConfig } from "@/ai/llm-provider";

import { completeCommand } from "./completions";
import { createLlmConsoleSession, type LlmConsoleSession } from "./llm-console-session";

const OLLAMA: LlmProviderConfig = {
  id: "ollama",
  name: "Ollama",
  kind: "http",
  baseUrl: "http://localhost:11434",
  apiKey: "",
  model: "llama3.2",
  isDefault: true,
};
const OPENAI: LlmProviderConfig = {
  id: "openai",
  name: "OpenAI",
  kind: "http",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-1",
  model: "gpt-4o-mini",
  isDefault: false,
};

/* ── a provider endpoint, as `fetch` sees one ───────────────────────────── */

type Seen = { url: string; body: { model?: string; messages?: unknown } | undefined };

/** What the stubbed endpoints answer; each test sets what it needs. */
let endpoint: {
  /** `GET …/models`, by request URL. */
  models: (url: string) => Response | Promise<Response>;
  /** `POST …/chat/completions`. */
  chat: (seen: Seen) => Response | Promise<Response>;
};
let requests: Seen[] = [];

const modelList = (...ids: string[]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

/** An OpenAI chat-completions SSE stream carrying `deltas`, then `[DONE]`. */
function answer(...deltas: string[]): Response {
  const frames = deltas.map((delta, index) =>
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { role: index === 0 ? "assistant" : undefined, content: delta },
          finish_reason: index === deltas.length - 1 ? "stop" : null,
        },
      ],
    }),
  );
  return new Response(`${frames.map((frame) => `data: ${frame}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  endpoint = { models: () => modelList("llama3.2", "qwen2.5:7b"), chat: () => answer("blue", ", mostly") };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const text = input instanceof Request ? await input.text() : (init?.body as string | undefined);
    const seen: Seen = { url, body: text ? JSON.parse(text) : undefined };
    requests.push(seen);
    return url.endsWith("/models") ? endpoint.models(url) : endpoint.chat(seen);
  }) as typeof fetch;
  // `hostFetch` memoises whatever it resolved, so a stub would leak otherwise.
  resetHostFetch();
  const providers = [{ ...OLLAMA }, { ...OPENAI }];
  useLlmProviderStore.setState({ providers, settled: providers, statuses: {} });
});

afterEach(() => {
  // A session left open would keep answering store edits made by later tests.
  for (const close of opened.splice(0)) close();
  // Ends the settle wait of whatever a test left typed.
  settleLlmProviders();
  globalThis.fetch = realFetch;
  resetHostFetch();
});

/* ── driving a session ──────────────────────────────────────────────────── */

const BROWSER = { desktop: false, origin: "https://microflow.test" };
const DESKTOP = { desktop: true, origin: "http://tauri.localhost" };

const opened: Array<() => void> = [];

/** Let answers that are already on their way land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function start(host = BROWSER) {
  const tracked: Array<[string, unknown]> = [];
  const session = createLlmConsoleSession({ host, track: (event, data) => tracked.push([event, data]) });
  opened.push(session.open());
  await settle();
  return { session, tracked };
}

/** The transcript as text: kind, then label, then what was said. */
function transcript(session: LlmConsoleSession): string[] {
  return session
    .getState()
    .lines.map((line) => [line.kind, line.label, line.text].filter(Boolean).join(" "));
}

const store = () => useLlmProviderStore.getState();
const chats = () => requests.filter((request) => !request.url.endsWith("/models"));

describe("ask", () => {
  test("sends the prompt as typed to the selected provider's model and shows the answer", async () => {
    const { session } = await start();

    await session.run("ask why is  the sky blue?");

    const [chat] = chats();
    expect(chat.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(chat.body?.model).toBe("llama3.2");
    expect(JSON.stringify(chat.body?.messages)).toContain("why is  the sky blue?");
    expect(transcript(session)).toEqual([
      "out llama3.2 why is  the sky blue?",
      "in llama3.2 blue, mostly",
    ]);
    expect(store().statuses.ollama).toBe("ok");
  });

  test("a line that is not a command is a prompt", async () => {
    const { session } = await start();

    await session.run("  Why is the sky blue?  ");

    expect(JSON.stringify(chats()[0].body?.messages)).toContain("Why is the sky blue?");
    expect(transcript(session)[0]).toBe("out llama3.2 Why is the sky blue?");
  });

  test("ask without a prompt says what it needs and sends nothing", async () => {
    const { session } = await start();

    await session.run("ask");

    expect(chats()).toEqual([]);
    expect(transcript(session)).toEqual(["err ask needs a prompt — try: ask why is the sky blue"]);
  });

  test("a failing provider leaves an error line and an error status", async () => {
    // A 4xx, which the transport does not retry.
    endpoint.chat = () => new Response("no such model", { status: 400, statusText: "Bad Request" });
    const { session } = await start();

    await session.run("ask anything");

    const { lines } = session.getState();
    expect(lines.map((line) => line.kind)).toEqual(["out", "err"]);
    expect(lines[1].text).not.toBe("");
    expect(store().statuses.ollama).toBe("error");
  });

  test("does nothing without a provider", async () => {
    useLlmProviderStore.setState({ providers: [] });
    const { session } = await start();

    await session.run("why is the sky blue?");

    expect(requests).toEqual([]);
    expect(session.getState()).toMatchObject({ selectedId: "", lines: [] });
  });
});

describe("model", () => {
  test("reads the provider's model, and sets it for everything that uses the provider", async () => {
    const { session } = await start();

    await session.run("model");
    await session.run("model qwen2.5:7b");
    await session.run("ask hello");

    expect(transcript(session).slice(0, 2)).toEqual(["sys model is llama3.2", "sys model set to qwen2.5:7b"]);
    expect(store().getProvider("ollama")?.model).toBe("qwen2.5:7b");
    expect(chats()[0].body?.model).toBe("qwen2.5:7b");
  });

  test("completes from the current model, then what the provider lists, then the known ones", async () => {
    const { session } = await start();
    const offered = () =>
      completeCommand(session.getState().commands, "model ").suggestions.map((entry) => entry.value);

    expect(session.getState().models).toEqual(["llama3.2", "qwen2.5:7b"]);
    expect(offered()).toEqual(["llama3.2", "qwen2.5:7b", "llama3.1", "mistral", "qwen2.5", "phi3"]);

    // An edit made on the settings form is an edit to the completions too.
    const before = session.getState().commands;
    store().updateProvider("ollama", { model: "deepseek-r1:8b" });
    expect(session.getState().commands).not.toBe(before);
    expect(offered()[0]).toBe("deepseek-r1:8b");
  });
});

describe("the provider's model list", () => {
  test("is asked for when the session opens, and again when the endpoint or the key settled to another", async () => {
    const { session } = await start();
    expect(requests.map((request) => request.url)).toEqual(["http://localhost:11434/v1/models"]);

    store().updateProvider("ollama", { name: "Local", model: "mistral" });
    settleLlmProviders();
    await settle();
    expect(requests).toHaveLength(1);

    endpoint.models = () => modelList("phi3");
    store().updateProvider("ollama", { baseUrl: "http://localhost:1234" });
    settleLlmProviders();
    await settle();
    expect(requests.at(-1)?.url).toBe("http://localhost:1234/v1/models");
    expect(session.getState().models).toEqual(["phi3"]);

    store().updateProvider("ollama", { apiKey: "sk-2" });
    settleLlmProviders();
    await settle();
    expect(requests).toHaveLength(3);
  });

  test("is not asked for with a key that is being typed, only with the key it settles to", async () => {
    const authorizations: string[] = [];
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      }
      return stubbed(input, init);
    }) as typeof fetch;
    resetHostFetch();
    const { session } = await start();
    session.select("openai");
    await settle();

    for (const key of ["s", "sk", "sk-", "sk-n", "sk-ne", "sk-new"]) {
      store().updateProvider("openai", { apiKey: key });
      await settle();
    }
    expect(authorizations).toEqual(["", "Bearer sk-1"]);

    settleLlmProviders();
    await settle();
    expect(authorizations).toEqual(["", "Bearer sk-1", "Bearer sk-new"]);
  });

  test("an answer that lands after the user moved on is not shown under another provider", async () => {
    let release = (_response: Response) => {};
    endpoint.models = (url) =>
      url.startsWith("http://localhost:11434")
        ? new Promise<Response>((resolve) => (release = resolve))
        : modelList("gpt-4o-mini", "o3-mini");
    const { session } = await start();

    session.select("openai");
    await settle();
    release(modelList("llama3.2"));
    await settle();

    expect(session.getState().models).toEqual(["gpt-4o-mini", "o3-mini"]);
  });

  test("is not asked for before the session opens or after it closes", async () => {
    const session = createLlmConsoleSession({ host: BROWSER });
    session.select("openai");
    await settle();
    expect(requests).toEqual([]);

    session.open()();
    await settle();
    requests = [];
    store().updateProvider("openai", { apiKey: "sk-3" });
    await settle();
    expect(requests).toEqual([]);
  });
});

describe("system", () => {
  test("sets a system prompt for the next ask, and clears it with no text", async () => {
    const { session } = await start();

    await session.run("system answer in one word");
    expect(session.getState().system).toBe("answer in one word");
    await session.run("ask why is the sky blue?");
    expect(JSON.stringify(chats()[0].body)).toContain("answer in one word");

    await session.run("system");
    await session.run("ask and now?");
    expect(JSON.stringify(chats()[1].body)).not.toContain("answer in one word");

    expect(transcript(session).filter((line) => line.startsWith("sys"))).toEqual([
      "sys system prompt set",
      "sys system prompt cleared",
    ]);
  });

  test("the settings form sets it without a transcript line, and each provider keeps its own", async () => {
    const { session } = await start();

    session.setSystemPrompt("be terse");
    expect(session.getState()).toMatchObject({ system: "be terse", lines: [] });

    session.select("openai");
    expect(session.getState().system).toBe("");
    session.select("ollama");
    expect(session.getState().system).toBe("be terse");
  });
});

describe("test", () => {
  const lastLine = (session: LlmConsoleSession) => transcript(session).at(-1);

  test("a reachable endpoint says so, turns the status ok and is counted", async () => {
    const { session, tracked } = await start();

    await session.run("test");

    expect(transcript(session)).toEqual(["sys probing http://localhost:11434…", "sys reachable"]);
    expect(store().statuses.ollama).toBe("ok");
    expect(tracked).toEqual([["llm_provider_tested", { family: "ollama", ok: true }]]);
  });

  test("a rejected key is blamed on the key, any other status on the URL", async () => {
    const { session, tracked } = await start();

    endpoint.models = () => new Response("{}", { status: 401 });
    await session.run("test");
    expect(lastLine(session)).toBe("err http://localhost:11434 answered 401 — check the API key.");

    endpoint.models = () => new Response("{}", { status: 404 });
    await session.run("test");
    expect(lastLine(session)).toBe(
      "err http://localhost:11434 answered 404 — check the URL points at the API root.",
    );

    expect(store().statuses.ollama).toBe("error");
    expect(tracked.at(-1)).toEqual(["llm_provider_tested", { family: "ollama", ok: false }]);
  });

  test("an endpoint that does not answer is a CORS question in a browser", async () => {
    const { session } = await start(BROWSER);
    endpoint.models = () => Promise.reject(new TypeError("Failed to fetch"));

    await session.run("test");

    expect(lastLine(session)).toBe(
      "err http://localhost:11434 is not reachable from this page — check that it is running and allows CORS from https://microflow.test.",
    );
  });

  test("and never one in the desktop app, where CORS does not apply", async () => {
    const { session } = await start(DESKTOP);
    endpoint.models = () => Promise.reject(new TypeError("Failed to fetch"));

    await session.run("test");

    expect(lastLine(session)).toBe(
      "err http://localhost:11434 did not answer — check that it is running and the URL is right.",
    );
  });
});

describe("the transcript", () => {
  test("clear empties it; ? and help answer with the command table", async () => {
    const { session } = await start();

    await session.run("?");
    await session.run("help");
    const [first, second] = session.getState().lines;
    expect(first.table?.map((command) => command.name)).toEqual(["ask", "model", "system", "test", "clear", "?"]);
    expect(second.table).toEqual(first.table);

    await session.run("clear");
    expect(session.getState().lines).toEqual([]);
    expect(chats()).toEqual([]);
  });

  test("switching provider starts an empty transcript; a deleted provider gives way to the first one left", async () => {
    const { session } = await start();
    await session.run("model");

    session.select("openai");
    expect(session.getState()).toMatchObject({ selectedId: "openai", lines: [] });

    store().deleteProvider("openai");
    expect(session.getState().selectedId).toBe("ollama");
  });
});

describe("an answer that lands after the user switched provider", () => {
  test("stays out of the other provider's transcript, and still settles its own provider's status", async () => {
    let release = (_response: Response) => {};
    endpoint.chat = () => new Promise<Response>((resolve) => (release = resolve));
    const { session } = await start();

    const asked = session.run("ask why is the sky blue?");
    while (chats().length === 0) await settle();
    session.select("openai");
    release(answer("blue"));
    await asked;

    expect(session.getState()).toMatchObject({ selectedId: "openai", lines: [] });
    expect(store().statuses.ollama).toBe("ok");
  });

  test("goes for a probe's verdict too", async () => {
    let release = (_response: Response) => {};
    const { session, tracked } = await start();
    endpoint.models = (url) =>
      url.startsWith("http://localhost:11434")
        ? new Promise<Response>((resolve) => (release = resolve))
        : modelList("gpt-4o-mini");

    const tested = session.run("test");
    await settle();
    session.select("openai");
    release(new Response("{}", { status: 401 }));
    await tested;

    expect(session.getState()).toMatchObject({ selectedId: "openai", lines: [] });
    expect(store().statuses.ollama).toBe("error");
    expect(tracked).toEqual([["llm_provider_tested", { family: "ollama", ok: false }]]);
  });

  test("but selecting the provider that is already selected changes nothing: the answer still shows", async () => {
    let release = (_response: Response) => {};
    endpoint.chat = () => new Promise<Response>((resolve) => (release = resolve));
    const { session } = await start();
    session.setSystemPrompt("be terse");

    const asked = session.run("ask why is the sky blue?");
    while (chats().length === 0) await settle();
    const before = session.getState();
    session.select("ollama");
    expect(session.getState()).toBe(before);
    release(answer("blue"));
    await asked;

    expect(transcript(session)).toEqual(["out llama3.2 why is the sky blue?", "in llama3.2 blue"]);
    expect(session.getState().system).toBe("be terse");
  });
});

describe("analytics", () => {
  test("a provider is reported as added once, and only when it has an endpoint", async () => {
    const { session, tracked } = await start();
    session.select(
      store().addProvider({ kind: "http", name: "Custom endpoint", baseUrl: "", apiKey: "", model: "", isDefault: false }),
    );

    session.reportConfigured();
    expect(tracked).toEqual([]);

    store().updateProvider(session.getState().selectedId, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or" });
    session.reportConfigured();
    session.reportConfigured();
    expect(tracked).toEqual([["llm_provider_added", { family: "openrouter", keyed: true }]]);
  });
});
