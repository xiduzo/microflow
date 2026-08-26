// The inbound serial stream reaches two decoders (ADR-0018): the detection
// session's codec, which answers the handshake, and the flow runtime's, which
// owns the pin table the flow runs on. They stay consistent only because
// `pumpReader` hands both the *identical* chunk sequence — neither is filtered,
// sampled, or gated on a lifecycle flag. Gate either one and the two pin tables
// can drift, so this pins the property rather than the implementation.

import { describe, expect, test } from "bun:test";
import { pumpReader } from "../web-serial";
import type { FirmataSession } from "../wasm";

/** A reader that yields `chunks`, then ends. */
function fakeReader(chunks: Uint8Array[]) {
  const queue = [...chunks];
  return {
    read: () =>
      Promise.resolve(
        queue.length > 0
          ? { value: queue.shift()!, done: false as const }
          : { done: true as const },
      ),
  };
}

describe("pumpReader fans one stream out to both decoders", () => {
  test("the detection codec and the flow runtime see the same chunks in the same order", async () => {
    const chunks = [new Uint8Array([0xf9, 2, 5]), new Uint8Array([0xe0, 0x00, 0x04])];
    const toCodec: Uint8Array[] = [];
    const toRuntime: Uint8Array[] = [];

    await pumpReader(
      fakeReader(chunks),
      {
        feed: (bytes: Uint8Array) => {
          toCodec.push(bytes);
          return "{}";
        },
      } as unknown as Pick<FirmataSession, "feed">,
      { onBytes: (bytes) => toRuntime.push(bytes) },
    );

    expect(toCodec).toEqual(chunks);
    expect(toRuntime).toEqual(chunks);
  });
});
