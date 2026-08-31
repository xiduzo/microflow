// Tool calls a model typed out as text, recovered into real tool calls.
//
// A small local model regularly gets the *intent* right and the *channel*
// wrong: asked to add a button and an LED it replies, as its whole message,
//
//     {"name":"add_node","type":"Button","data":{"config":{"pin":13}}}
//
// instead of putting that in the `tool_calls` field. Ask AI then shows the JSON
// to the user and the canvas never changes — the failure in this session's
// screenshot. It is not a transport bug: llama3.2 does this through Ollama's
// `/v1` shim and its native `/api/chat` alike, on maybe half its turns, because
// a 3B model's tool syntax only sometimes survives the server's parser. Every
// OpenAI-compatible local server (Ollama, LM Studio, llama.cpp) leaks the same
// way, which is why this sits in the shared transport rather than next to one
// of them.
//
// Recovery is deliberately narrow: it fires only when the request offered tools,
// the turn produced no real tool call, and the reply parses as JSON naming a
// tool that was actually offered. A model answering a genuine question about
// JSON cannot trip it — it would have to emit nothing but an object named after
// one of our own tools, which is the case we are here to catch.
//
// Half of llama3.2's attempts are also malformed (`{"name":"x",""parameters":…`,
// or a brace short), so a clean parse alone recovers little. The salvage pass
// below reads the tool name and then the arguments *object* on its own, which
// is usually well-formed even when the wrapper around it is not.
//
// ponytail: salvage stops at a mangled arguments object — the tool is then
// called with no arguments and rejects, which puts the model in its own retry
// loop rather than a JSON repairer in this file.

/** SSE and JSON bodies both funnel through here; only chat completions carry
 *  tool calls, so nothing else is touched. */
const CHAT_PATH = "/chat/completions";

type ToolCall = {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type Delta = { content?: string; tool_calls?: unknown[] };
type Chunk = {
  id?: string;
  model?: string;
  choices?: Array<{ index?: number; delta?: Delta; message?: Delta; finish_reason?: string | null }>;
};

/** The tool names this request offered, or `[]` if it offered none. */
function offeredTools(body: unknown): string[] {
  const tools = (body as { tools?: Array<{ function?: { name?: unknown } }> }).tools ?? [];
  return tools.map((tool) => String(tool.function?.name ?? "")).filter(Boolean);
}

/**
 * Read tool calls out of a message the model wrote as text.
 *
 * Three shapes in the wild, all accepted because all three are what actually
 * arrives: arguments under `parameters`, under `arguments`, or — as in the
 * screenshot — flattened alongside `name`. One object per line, since a model
 * that means two calls writes them on two lines.
 */
export function recoverToolCalls(content: string, offered: readonly string[]): ToolCall[] {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];

  const candidates: unknown[] = [];
  const push = (raw: string) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) candidates.push(...parsed);
      else candidates.push(parsed);
    } catch {
      // A line that is not JSON is not a tool call; the rest may still be.
    }
  };
  push(trimmed);
  if (candidates.length === 0) for (const line of trimmed.split("\n")) if (line.trim()) push(line.trim());
  if (candidates.length === 0) return salvageToolCalls(trimmed, offered);

  const calls: ToolCall[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const { name, parameters, arguments: args, ...rest } = candidate as Record<string, unknown>;
    // Only a name we actually offered — anything else is the model talking
    // about JSON, not calling a tool.
    if (typeof name !== "string" || !offered.includes(name)) continue;

    const explicit = parameters ?? args;
    const input =
      explicit && typeof explicit === "object" ? (explicit as Record<string, unknown>) : rest;
    calls.push({
      index: calls.length,
      id: `call_recovered_${calls.length}`,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    });
  }
  return calls;
}

/**
 * The arguments object that follows `position`, read on its own terms.
 *
 * Brace-counting rather than parsing, because the text around it is what broke.
 * A missing closing brace — the other half of what these models emit — is
 * closed here rather than thrown away.
 */
function argumentsAt(text: string, position: number): Record<string, unknown> | undefined {
  const open = text.indexOf("{", position);
  if (open < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = text.length;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') inString = !inString;
    else if (!inString && char === "{") depth += 1;
    else if (!inString && char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  const body = text.slice(open, end) + (depth > 0 ? "}".repeat(depth) : "");
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Last resort for a call whose JSON does not parse: find a tool name we offered
 * and read the arguments object that follows it.
 *
 * Not a JSON repairer — it never tries to fix the broken text, it just reads
 * the one part of it that is usually intact. A name with no readable arguments
 * still becomes a call, because an `add_node` that is rejected for missing
 * `type` tells the model what to do next; silence tells it nothing.
 */
function salvageToolCalls(text: string, offered: readonly string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) {
    const name = match[1];
    if (!offered.includes(name)) continue;
    const from = (match.index ?? 0) + match[0].length;
    // Only arguments the model labelled as such: the first `{` after a bare
    // name could be anything.
    const label = /"(?:parameters|arguments)"/.exec(text.slice(from));
    const input = label ? (argumentsAt(text, from + label.index) ?? {}) : {};
    calls.push({
      index: calls.length,
      id: `call_recovered_${calls.length}`,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    });
  }
  return calls;
}

function chunkWith(base: Chunk, delta: Delta, finish: string | null) {
  return {
    id: base.id ?? "chatcmpl-recovered",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: base.model ?? "",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/**
 * Rewrite an SSE stream, converting a text-only tool call into a real one.
 *
 * Text is streamed through until the first `{`, and held from there to the end
 * of the turn — the earliest point at which we can tell a tool call from an
 * answer that merely contains a brace. That covers both shapes these models
 * produce: the reply that is nothing but the call, and the one that explains
 * itself first and then writes the call underneath. Ordinary prose streams with
 * no added latency, and nothing is ever dropped: text that does not recover is
 * released exactly as it arrived.
 */
function recoverStream(source: Response, offered: readonly string[]): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: string) => controller.enqueue(encoder.encode(line));
      const sendChunk = (payload: unknown) => send(`data: ${JSON.stringify(payload)}\n\n`);

      let buffer = "";
      /** Text from the first `{` onwards, not yet released to the client. */
      let held = "";
      let sawToolCall = false;
      let last: Chunk = {};

      const release = () => {
        if (held.length > 0) sendChunk(chunkWith(last, { content: held }, null));
        held = "";
      };

      /** Decide what the held text was. Returns true if it was a tool call, in
       *  which case it is delivered as one and never shown to the user. */
      const finalize = (): boolean => {
        const calls = recoverToolCalls(held, offered);
        if (calls.length === 0) {
          release();
          return false;
        }
        held = "";
        sendChunk(chunkWith(last, { tool_calls: calls }, null));
        sendChunk(chunkWith(last, {}, "tool_calls"));
        return true;
      };

      const event = (block: string) => {
        const payload = block.slice(block.indexOf("data: ") + 6).trim();
        if (payload === "[DONE]") return;

        let chunk: Chunk;
        try {
          chunk = JSON.parse(payload) as Chunk;
        } catch {
          send(`${block}\n\n`);
          return;
        }
        last = chunk;

        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};
        if (delta.tool_calls) sawToolCall = true;

        // A model that got it right needs nothing from us, buffering included —
        // from the first real tool call on, this is a passthrough.
        if (sawToolCall) {
          release();
          send(`${block}\n\n`);
          return;
        }

        const content = typeof delta.content === "string" ? delta.content : "";
        let sent = false;
        if (content.length > 0) {
          const all = held + content;
          const brace = all.indexOf("{");
          const free = brace < 0 ? all : all.slice(0, brace);
          held = brace < 0 ? "" : all.slice(brace);
          if (free.length > 0) {
            // The whole delta passing through untouched is the common case, and
            // forwarding the original block keeps whatever else it carried
            // (`role` on the first one, most importantly).
            if (free === content) send(`${block}\n\n`);
            else sendChunk(chunkWith(last, { content: free }, null));
            sent = true;
          }
        }

        if (choice?.finish_reason != null) {
          // The finish is where a text tool call has to be caught: once it is
          // sent as `stop` the loop ends the turn and runs nothing.
          if (finalize()) return;
          if (!sent) send(`${block}\n\n`);
          return;
        }

        if (!sent && content.length === 0) send(`${block}\n\n`);
      };

      try {
        const reader = source.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) if (block.includes("data: ")) event(block);
        }
        if (buffer.includes("data: ")) event(buffer);
        // A stream that ended without a finish reason still gets its chance.
        finalize();
        send("data: [DONE]\n\n");
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    status: source.status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The same recovery for a non-streamed completion. */
async function recoverJson(source: Response, offered: readonly string[]): Promise<Response> {
  const body = (await source.json()) as Chunk;
  const choice = body.choices?.[0];
  const message = choice?.message;
  const calls =
    message && !message.tool_calls ? recoverToolCalls(message.content ?? "", offered) : [];
  if (calls.length === 0 || !choice || !message) {
    return new Response(JSON.stringify(body), {
      status: source.status,
      headers: { "content-type": "application/json" },
    });
  }

  message.content = "";
  message.tool_calls = calls;
  choice.finish_reason = "tool_calls";
  return new Response(JSON.stringify(body), {
    status: source.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Wrap a `fetch` so a tool call written as message text still runs.
 *
 * Anything that is not a tool-carrying chat completion — and any response the
 * endpoint refused — passes through untouched, so an endpoint's own error still
 * reaches the adapter rather than one invented here.
 */
export function recoverTextToolCalls(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith(CHAT_PATH) || typeof init?.body !== "string") return inner(input, init);

    let request: unknown;
    try {
      request = JSON.parse(init.body);
    } catch {
      return inner(input, init);
    }
    const offered = offeredTools(request);
    if (offered.length === 0) return inner(input, init);

    const response = await inner(input, init);
    if (!response.ok || !response.body) return response;

    return (request as { stream?: boolean }).stream
      ? recoverStream(response, offered)
      : recoverJson(response, offered);
  };
}
