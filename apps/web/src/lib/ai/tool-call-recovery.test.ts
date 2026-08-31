import { describe, expect, it } from "bun:test";

import { recoverTextToolCalls, recoverToolCalls } from "./tool-call-recovery";

const OFFERED = ["get_flow", "add_node", "connect"];

/** An OpenAI SSE body from a list of deltas. */
function sse(deltas: Array<{ delta?: unknown; finish_reason?: string }>): Response {
  const body = deltas
    .map((d) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        model: "llama3.2",
        choices: [{ index: 0, delta: d.delta ?? {}, finish_reason: d.finish_reason ?? null }],
      })}\n\n`,
    )
    .join("");
  return new Response(`${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function chunksOf(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice(6)) as { choices: Array<Record<string, never>> });
}

const post = (fetchImpl: typeof fetch, body: Record<string, unknown>) =>
  fetchImpl("http://localhost:11434/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ tools: OFFERED.map((name) => ({ function: { name } })), ...body }),
  });

describe("recoverToolCalls", () => {
  it("reads the shapes models actually write", () => {
    // Arguments nested under `parameters` — llama3.2's own tool syntax.
    expect(recoverToolCalls('{"name":"add_node","parameters":{"type":"Led"}}', OFFERED)).toEqual([
      { index: 0, id: "call_recovered_0", type: "function", function: { name: "add_node", arguments: '{"type":"Led"}' } },
    ]);

    // Flattened alongside `name`, which is what the reported failure looked like.
    const flat = recoverToolCalls('{"name":"connect","source":"Button","sourceHandle":"active"}', OFFERED);
    expect(JSON.parse(flat[0].function.arguments)).toEqual({ source: "Button", sourceHandle: "active" });

    // One call per line: a model that means two writes two.
    const two = recoverToolCalls(
      '{"name":"add_node","arguments":{"type":"Button"}}\n{"name":"add_node","arguments":{"type":"Led"}}',
      OFFERED,
    );
    expect(two.map((c) => c.function.name)).toEqual(["add_node", "add_node"]);
    expect(two[1].index).toBe(1);
  });

  it("leaves alone anything that is not one of our tools", () => {
    // Prose, JSON that names no tool, and a tool name we never offered: all
    // answers, not calls. A false positive here would eat the user's reply.
    expect(recoverToolCalls("Sure — connect the Button to the Led.", OFFERED)).toEqual([]);
    expect(recoverToolCalls('{"pin": 13, "mode": "output"}', OFFERED)).toEqual([]);
    expect(recoverToolCalls('{"name":"rm_rf","parameters":{}}', OFFERED)).toEqual([]);
  });

  it("salvages the malformed calls a 3B model actually emits", () => {
    // Verbatim from llama3.2 against a local Ollama: a doubled quote, and a
    // brace short. The arguments object inside each is intact, which is the
    // whole reason it can be read at all.
    const doubled = recoverToolCalls(
      '{"name":"add_node",""parameters":{"type":"Button","data":{}}}',
      OFFERED,
    );
    expect(JSON.parse(doubled[0].function.arguments)).toEqual({ type: "Button", data: {} });

    const truncated = recoverToolCalls('{"name":"add_node","parameters":{"type":"Led"}', OFFERED);
    expect(JSON.parse(truncated[0].function.arguments)).toEqual({ type: "Led" });

    // Arguments past reading: still a call, so the tool's own rejection tells
    // the model what to fix. Silence would not.
    const wrecked = recoverToolCalls('{"name":"add_node","parameters}{}}', OFFERED);
    expect(wrecked[0].function.arguments).toBe("{}");
  });
});

describe("recoverTextToolCalls", () => {
  it("turns a streamed text tool call into a real one the loop can run", async () => {
    const fetchImpl = recoverTextToolCalls((async () =>
      sse([
        { delta: { content: '{"name":"add_node",' } },
        { delta: { content: '"parameters":{"type":"Led"}}' } },
        { delta: {}, finish_reason: "stop" },
      ])) as typeof fetch);

    const chunks = await chunksOf(await post(fetchImpl, { stream: true }));
    const call = chunks[0].choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe("add_node");
    // "stop" here ends the turn without running anything — the actual bug.
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe("tool_calls");
    // The JSON must not also reach the user as the assistant's answer.
    expect(chunks.some((c) => c.choices[0].delta.content)).toBe(false);
  });

  it("passes prose and real tool calls through untouched", async () => {
    const prose = recoverTextToolCalls((async () =>
      sse([
        { delta: { content: "The Button " } },
        { delta: { content: "is already wired." } },
        { delta: {}, finish_reason: "stop" },
      ])) as typeof fetch);
    const chunks = await chunksOf(await post(prose, { stream: true }));
    expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe(
      "The Button is already wired.",
    );
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe("stop");

    const real = recoverTextToolCalls((async () =>
      sse([
        { delta: { tool_calls: [{ index: 0, id: "call_0", function: { name: "get_flow", arguments: "{}" } }] } },
        { delta: {}, finish_reason: "tool_calls" },
      ])) as typeof fetch);
    const untouched = await chunksOf(await post(real, { stream: true }));
    expect(untouched[0].choices[0].delta.tool_calls[0].id).toBe("call_0");
  });

  it("catches a call the model explains before writing", async () => {
    // The other half of the failure: prose, then the call underneath it. The
    // prose is still the assistant's answer; only the JSON becomes the call.
    const fetchImpl = recoverTextToolCalls((async () =>
      sse([
        { delta: { content: "I will add the LED now.\n\n" } },
        { delta: { content: '{"name": "add_node", "parameters": {"type": "Led"}}' } },
        { delta: {}, finish_reason: "stop" },
      ])) as typeof fetch);

    const chunks = await chunksOf(await post(fetchImpl, { stream: true }));
    expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe(
      "I will add the LED now.\n\n",
    );
    expect(chunks.at(-2)!.choices[0].delta.tool_calls[0].function.name).toBe("add_node");
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe("tool_calls");
  });

  it("holds JSON-looking prose back only until it knows, then releases it", async () => {
    // A reply that opens with a brace but is not a call must still reach the
    // user in full — buffering it is only allowed to cost latency, never text.
    const fetchImpl = recoverTextToolCalls((async () =>
      sse([
        { delta: { content: '{"pin": 13} ' } },
        { delta: { content: "is what that node is set to." } },
        { delta: {}, finish_reason: "stop" },
      ])) as typeof fetch);

    const chunks = await chunksOf(await post(fetchImpl, { stream: true }));
    expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe(
      '{"pin": 13} is what that node is set to.',
    );
  });

  it("recovers a non-streamed completion too, and ignores a request with no tools", async () => {
    const json = (content: string) =>
      new Response(
        JSON.stringify({
          id: "1",
          model: "llama3.2",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const fetchImpl = recoverTextToolCalls((async () =>
      json('{"name":"get_flow","parameters":{}}')) as typeof fetch);

    const body = (await (await post(fetchImpl, { stream: false })).json()) as never;
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_flow");
    expect(body.choices[0].finish_reason).toBe("tool_calls");

    // No tools offered means nothing to recover into — pass straight through.
    const untouched = await recoverTextToolCalls((async () => json('{"name":"get_flow"}')) as typeof fetch)(
      "http://localhost:11434/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ stream: false, messages: [] }) },
    );
    expect(((await untouched.json()) as never).choices[0].message.content).toBe(
      '{"name":"get_flow"}',
    );
  });
});
