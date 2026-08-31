import { describe, expect, test } from "bun:test";
import {
  applyCompletion,
  completeCommand,
  tokenizeArgs,
  tokenizeCommand,
  type ConsoleCommand,
} from "./completions";

const COMMANDS: ConsoleCommand[] = [
  { name: "subscribe", args: "<topic>", help: "Listen", aliases: ["sub"], values: () => ["test/#", "test/led"] },
  { name: "unsubscribe", args: "<topic>", help: "Stop listening", aliases: ["unsub"] },
  { name: "publish", args: "<topic> <payload>", help: "Send", values: () => ["test/#"] },
  { name: "clear", help: "Empty the transcript" },
];

describe("completeCommand", () => {
  test("matches anywhere in a command name, prefix matches first", () => {
    expect(completeCommand(COMMANDS, "sub").suggestions.map((s) => s.value)).toEqual([
      "subscribe",
      "unsubscribe",
    ]);
  });

  test("never offers a command that is already fully typed", () => {
    expect(completeCommand(COMMANDS, "clear").suggestions).toEqual([]);
  });

  test("shows the argument signature once the command name is complete", () => {
    const completion = completeCommand(COMMANDS, "publish ");
    expect(completion.signature).toBe("<topic> <payload>");
  });

  test("completes the first argument from the command's values", () => {
    const completion = completeCommand(COMMANDS, "subscribe test/l");
    expect(completion.suggestions.map((s) => s.value)).toEqual(["test/led"]);
    expect(completion.prefix).toBe("test/l");
  });

  test("an alias completes its command's values too", () => {
    expect(completeCommand(COMMANDS, "sub test/").suggestions).toHaveLength(2);
  });

  test("stops completing past the first argument — a payload is free text", () => {
    expect(completeCommand(COMMANDS, "publish test/# hello te").suggestions).toEqual([]);
  });

  test("a command without values offers nothing for its argument", () => {
    expect(completeCommand(COMMANDS, "unsubscribe te").suggestions).toEqual([]);
  });

  test("an empty input completes nothing", () => {
    expect(completeCommand(COMMANDS, "")).toEqual({ suggestions: [], prefix: "", signature: "" });
  });
});

describe("applyCompletion", () => {
  test("replaces the prefix under the caret and leaves room to keep typing", () => {
    expect(applyCompletion("subscribe test/l", "test/l", "test/led")).toBe("subscribe test/led ");
  });

  test("replaces a bare verb", () => {
    expect(applyCompletion("sub", "sub", "subscribe")).toBe("subscribe ");
  });
});

describe("tokenizeCommand", () => {
  const kinds = (input: string) =>
    tokenizeCommand(COMMANDS, input)
      .filter((token) => token.kind !== "space")
      .map((token) => `${token.text}:${token.kind}`);

  test("colours a command, its argument and its free text apart", () => {
    expect(kinds("publish test/led hello there")).toEqual([
      "publish:command",
      "test/led:arg",
      "hello:text",
      "there:text",
    ]);
  });

  test("an alias is still a command", () => {
    expect(kinds("sub test/#")).toEqual(["sub:command", "test/#:arg"]);
  });

  test("an unrecognised verb is marked as such", () => {
    expect(kinds("nope test/#")).toEqual(["nope:unknown", "test/#:text"]);
  });

  test("preserves whitespace verbatim so an overlay stays aligned", () => {
    const line = "publish  test/led  hello  there";
    expect(tokenizeCommand(COMMANDS, line).map((token) => token.text).join("")).toBe(line);
  });

  test("a command with one structured argument colours only that one", () => {
    expect(kinds("subscribe test/# extra")).toEqual([
      "subscribe:command",
      "test/#:arg",
      "extra:arg",
    ]);
  });
});

describe("tokenizeArgs", () => {
  test("splits a signature into argument and free-text parts", () => {
    expect(tokenizeArgs(COMMANDS[2]).filter((t) => t.kind !== "space")).toEqual([
      { text: "<topic>", kind: "arg" },
      { text: "<payload>", kind: "text" },
    ]);
  });

  test("a command without arguments has no signature", () => {
    expect(tokenizeArgs(COMMANDS[3])).toEqual([]);
  });
});
