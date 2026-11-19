import { describe, expect, test } from "bun:test";
import { mirrorNameToDocument } from "./flow-rename";

/**
 * The retry policy of the rename mirror, with the document write injected.
 * That a rename writes the row and the document (live room or store), and
 * that a failed document write does not fail it, is tested through the Flow
 * library in `flow-library.test.ts`.
 */

describe("mirrorNameToDocument", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("a failed write is retried with backoff until it lands", async () => {
    let calls = 0;
    const write = async () => {
      if (++calls < 3) throw new Error("store unavailable");
    };
    await mirrorNameToDocument("flow-1", "Renamed", write, [5, 5, 5]);
    expect(calls).toBe(1); // the mutation waits for the first attempt only

    await tick(80);
    expect(calls).toBe(3); // two retries; the second landed, no more after it
  });

  test("it gives up after the last delay", async () => {
    let calls = 0;
    const write = async () => {
      calls++;
      throw new Error("store unavailable");
    };
    await mirrorNameToDocument("flow-1", "Renamed", write, [5, 5]);
    await tick(80);
    expect(calls).toBe(3);
  });
});
