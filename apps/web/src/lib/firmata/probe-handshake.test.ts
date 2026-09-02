import { describe, expect, test } from "bun:test";
import {
  advance,
  startHandshake,
  BAUD_RATES,
  CAPABILITY_TIMEOUT_MS,
  FIRMWARE_REQUERY_MS,
  FIRMWARE_TIMEOUT_MS,
  type HandshakeAction,
  type HandshakeObservation,
  type HandshakeState,
} from "./probe-handshake";

const SILENT: HandshakeObservation = { firmwareName: "", pinCount: 0 };
const ANSWERED: HandshakeObservation = { firmwareName: "StandardFirmata.ino", pinCount: 0 };

/** Drive the machine from `t0`, feeding one observation per step. */
function run(
  observations: Array<{ at: number; observed: HandshakeObservation }>,
  t0 = 1_000,
): HandshakeAction[] {
  let state: HandshakeState = startHandshake(t0);
  const actions: HandshakeAction[] = [];
  for (const { at, observed } of observations) {
    const step = advance(state, at, observed);
    state = step.state;
    actions.push(step.action);
  }
  return actions;
}

describe("baud order", () => {
  test("tries StandardFirmata's own default first", () => {
    // Duplicated in the desktop's `find_firmata_baud`; the order matters because
    // a board answering at both would otherwise be opened differently per host.
    expect([...BAUD_RATES]).toEqual([57600, 115200]);
  });
});

describe("firmware phase", () => {
  test("sends the query immediately, without a special first-send case", () => {
    expect(run([{ at: 1_000, observed: SILENT }])).toEqual([{ kind: "sendFirmwareQuery" }]);
  });

  test("polls between requeries rather than spinning", () => {
    const actions = run([
      { at: 1_000, observed: SILENT },
      { at: 1_100, observed: SILENT },
      { at: 1_500, observed: SILENT },
    ]);
    expect(actions[0]).toEqual({ kind: "sendFirmwareQuery" });
    expect(actions[1]).toEqual({ kind: "poll", delayMs: 100 });
    expect(actions[2]).toEqual({ kind: "poll", delayMs: 100 });
  });

  test("re-sends once the requery interval has elapsed", () => {
    // A board still booting misses the first query, and StandardFirmata never
    // re-announces itself — without this, a slow board is simply never found.
    const actions = run([
      { at: 1_000, observed: SILENT },
      { at: 1_000 + FIRMWARE_REQUERY_MS, observed: SILENT },
    ]);
    expect(actions[1]).toEqual({ kind: "sendFirmwareQuery" });
  });

  test("gives up at the deadline so the next baud gets a turn", () => {
    const actions = run([
      { at: 1_000, observed: SILENT },
      { at: 1_000 + FIRMWARE_TIMEOUT_MS, observed: SILENT },
    ]);
    expect(actions[1]).toEqual({ kind: "noFirmata" });
  });

  test("a firmware name arriving on the deadline step still wins", () => {
    // The board answered; timing out on the same tick would discard a working
    // connection.
    const actions = run([
      { at: 1_000, observed: SILENT },
      { at: 1_000 + FIRMWARE_TIMEOUT_MS, observed: ANSWERED },
    ]);
    expect(actions[1]).toEqual({ kind: "sendCapabilityQueries" });
  });
});

describe("capability phase", () => {
  test("asks for capabilities as soon as the firmware answers", () => {
    const actions = run([
      { at: 1_000, observed: SILENT },
      { at: 1_200, observed: ANSWERED },
    ]);
    expect(actions[1]).toEqual({ kind: "sendCapabilityQueries" });
  });

  test("connects once the pin table is sized", () => {
    const actions = run([
      { at: 1_000, observed: SILENT },
      { at: 1_200, observed: ANSWERED },
      { at: 1_300, observed: { firmwareName: "StandardFirmata.ino", pinCount: 20 } },
    ]);
    expect(actions[2]).toEqual({ kind: "connected" });
  });

  test("waits while the pin table is still empty", () => {
    const actions = run([
      { at: 1_000, observed: SILENT },
      { at: 1_200, observed: ANSWERED },
      { at: 1_300, observed: ANSWERED },
    ]);
    expect(actions[2]).toEqual({ kind: "poll", delayMs: 100 });
  });

  test("a capability timeout connects anyway — it is not fatal", () => {
    // The firmware already answered, so the board is real. Unlike the firmware
    // phase, timing out here must not throw the connection away; the runtime is
    // seeded with the pin table separately.
    const actions = run([
      { at: 1_000, observed: SILENT },
      { at: 1_200, observed: ANSWERED },
      { at: 1_200 + CAPABILITY_TIMEOUT_MS, observed: ANSWERED },
    ]);
    expect(actions[2]).toEqual({ kind: "connected" });
  });
});

describe("the two phases time out differently", () => {
  test("no firmware is fatal, no capabilities is not", () => {
    // The single rule most easily lost when this was written inline as two
    // near-identical polling loops.
    const noFirmware = run([
      { at: 1_000, observed: SILENT },
      { at: 1_000 + FIRMWARE_TIMEOUT_MS, observed: SILENT },
    ]).at(-1);
    const noCapabilities = run([
      { at: 1_000, observed: SILENT },
      { at: 1_200, observed: ANSWERED },
      { at: 1_200 + CAPABILITY_TIMEOUT_MS, observed: ANSWERED },
    ]).at(-1);

    expect(noFirmware).toEqual({ kind: "noFirmata" });
    expect(noCapabilities).toEqual({ kind: "connected" });
  });
});
