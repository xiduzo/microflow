// The safe state against the *compiled* detection codec, not a fake: the bytes
// come from `FirmataSession.encodeSafeState` (core's `encode_safe_state`), so a
// safe state that carried a pin's HIGH into a port value would fail here.
//
// Needs the generated module: `bun run build:wasm:firmata`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FirmataSession, initSync } from "./generated/microflow_firmata_wasm.js";
import { FIRMATA_SYSTEM_RESET } from "./board-link";

initSync({
  module: readFileSync(new URL("./generated/microflow_firmata_wasm_bg.wasm", import.meta.url)),
});

/** A CAPABILITY_RESPONSE advertising `pins` pins, each INPUT + OUTPUT. */
function capabilityResponse(pins: number): Uint8Array {
  const body: number[] = [];
  for (let pin = 0; pin < pins; pin += 1) body.push(0x00, 0x01, 0x01, 0x01, 0x7f);
  return Uint8Array.of(0xf0, 0x6c, ...body, 0xf7);
}

describe("encodeSafeState over the wasm codec", () => {
  test("every digital port goes to 0 around SYSTEM_RESET, even where the flow left pins HIGH", () => {
    const session = new FirmataSession();
    session.feed(capabilityResponse(20));
    const ports = Math.ceil((JSON.parse(session.pinsJson()) as unknown[]).length / 8);
    expect(ports).toBe(3);

    // The flow drove pins 3 and 13 HIGH; the codec tracks the port values.
    expect(Array.from(session.encodeDigitalWrite(3, true))).toEqual([0x90, 0x08, 0x00]);
    expect(Array.from(session.encodeDigitalWrite(13, true))).toEqual([0x91, 0x20, 0x00]);

    const zeroed = [0x90, 0, 0, 0x91, 0, 0, 0x92, 0, 0];
    expect(Array.from(session.encodeSafeState())).toEqual([...zeroed, FIRMATA_SYSTEM_RESET, ...zeroed]);
    session.free();
  });
});
