import { describe, expect, test } from "bun:test";
import { parseCommand, restAfter } from "./parse-command";

describe("parseCommand", () => {
  test("splits a verb from its tokens", () => {
    const parsed = parseCommand("sub test/#");
    expect(parsed.verb).toBe("sub");
    expect(parsed.tokens).toEqual(["test/#"]);
    expect(parsed.rest).toBe("test/#");
  });

  test("lowercases the verb but never the arguments", () => {
    expect(parseCommand("  PUB Test/Topic Hello ").verb).toBe("pub");
    expect(parseCommand("  PUB Test/Topic Hello ").tokens).toEqual(["Test/Topic", "Hello"]);
  });

  test("an empty input parses to an empty verb", () => {
    expect(parseCommand("   ")).toEqual({ verb: "", tokens: [], rest: "" });
  });
});

describe("restAfter", () => {
  test("keeps a payload's inner whitespace intact", () => {
    expect(restAfter(parseCommand("pub test/a hello  world"), 1)).toBe("hello  world");
  });

  test("returns an empty string when nothing follows", () => {
    expect(restAfter(parseCommand("pub test/a"), 1)).toBe("");
  });

  test("a prompt survives verbatim after one verb", () => {
    expect(restAfter(parseCommand("ask why is  the sky blue?"), 0)).toBe("why is  the sky blue?");
  });
});
