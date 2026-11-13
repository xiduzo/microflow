// The board link's lifecycle, over the fake port: open → probe → ready →
// attached → lost → closed. No browser, no board, no wasm, no wall clock.

import { describe, expect, test } from "bun:test";
import {
  probeBoard,
  safeStateBytes,
  FIRMATA_SYSTEM_RESET,
  type BoardConnection,
  type LinkLoss,
  type ProbeEnv,
  type ProbeHooks,
} from "./board-link";
import {
  FakeClock,
  FakeSerialPort,
  FakeSession,
  firmataDevice,
  flush,
  silentDevice,
} from "./link-fakes";

function env(clock: FakeClock, granted: FakeSerialPort[] = []): ProbeEnv {
  return {
    clock,
    createSession: async () => new FakeSession().asSession(),
    listGrantedPorts: async () => granted,
  };
}

async function probe(
  clock: FakeClock,
  port: FakeSerialPort,
  hooks: ProbeHooks = {},
): Promise<BoardConnection | null> {
  return clock.run(probeBoard(env(clock), port, hooks, { afterFlash: false }));
}

/** A link that got through the handshake, plus the losses it reports. */
async function readyLink(clock = new FakeClock(), port = new FakeSerialPort()) {
  const losses: LinkLoss[] = [];
  const link = await probe(clock, port, { onLost: (_link, loss) => losses.push(loss) });
  if (!link) throw new Error("expected the fake board to answer the probe");
  return { link, port, clock, losses };
}

const bytes = (...values: number[]) => Uint8Array.of(...values);

describe("probe", () => {
  test("a write that throws during the handshake closes the port, and the next probe can open it", async () => {
    const clock = new FakeClock();
    const port = new FakeSerialPort({ ...firmataDevice(), failWrite: () => true });

    expect(await probe(clock, port)).toBeNull();
    // Both bauds were tried and each left the port closed again — before the
    // fix, the first throw left it open with its streams locked.
    expect(port.isOpen).toBe(false);
    expect(port.opens).toBe(2);
    expect(port.closes).toBe(2);
    expect(port.readable).toBeNull();

    // The board recovers; a retry opens the same port.
    port.device = firmataDevice();
    const link = await probe(clock, port);
    expect(link?.phase).toBe("ready");
    expect(port.isOpen).toBe(true);
  });

  test("a device that never answers is given up on at every baud, port closed", async () => {
    const clock = new FakeClock();
    const port = new FakeSerialPort(silentDevice());

    expect(await probe(clock, port)).toBeNull();
    expect(port.isOpen).toBe(false);
    expect(port.closes).toBe(port.opens);
  });

  test("the pin seed is the detection codec's table at handshake time", async () => {
    const { link } = await readyLink();
    expect(JSON.parse(link.pinSeed)).toHaveLength(20);
  });
});

describe("inbound stream", () => {
  test("bytes that arrive before the runtime attaches are replayed in order, then streamed", async () => {
    const { link, port } = await readyLink();
    port.emit(bytes(1));
    port.emit(bytes(2));
    await flush();

    const received: number[] = [];
    link.attachInbound((chunk) => received.push(...chunk));
    expect(received).toEqual([1, 2]);

    port.emit(bytes(3));
    await flush();
    expect(received).toEqual([1, 2, 3]);
    expect(link.phase).toBe("attached");
  });

  test("handshake traffic is not replayed: the seed already covers it", async () => {
    const { link } = await readyLink();
    const received: Uint8Array[] = [];
    link.attachInbound((chunk) => received.push(chunk));
    expect(received).toEqual([]);
  });
});

describe("loss", () => {
  test("a write that rejects mid-session turns the link lost and reports it once", async () => {
    const { link, port, losses } = await readyLink();
    link.attachInbound(() => {});
    port.device = { ...firmataDevice(), failWrite: () => true };

    expect(link.write(bytes(0x90, 1, 0))).rejects.toThrow();
    await flush();
    expect(link.write(bytes(0x90, 0, 0))).rejects.toThrow();
    await flush();

    expect(link.phase).toBe("lost");
    expect(losses.map((l) => l.cause)).toEqual(["writeFailed"]);
  });

  test("the reader ending reports a loss", async () => {
    const { link, port, losses } = await readyLink();
    port.unplug();
    await flush();
    expect(link.phase).toBe("lost");
    expect(losses).toEqual([{ cause: "readerEnded" }]);
  });

  test("a deliberate disconnect is not a loss", async () => {
    const { link, clock, losses } = await readyLink();
    await clock.run(link.disconnect());
    expect(losses).toEqual([]);
  });
});

describe("close", () => {
  test("disconnect drives outputs low, resets Firmata, then closes the port — once", async () => {
    const { link, port, clock } = await readyLink();
    const before = port.written.length;

    const closing = link.disconnect();
    expect(link.disconnect()).toBe(closing);
    await clock.run(closing);

    const tail = Array.from(port.written.slice(before).at(-1) ?? []);
    // 20 pins = 3 digital ports, each written to 0, then SYSTEM_RESET.
    expect(tail).toEqual([0x90, 0, 0, 0x91, 0, 0, 0x92, 0, 0, FIRMATA_SYSTEM_RESET]);
    expect(port.isOpen).toBe(false);
    expect(port.closes).toBe(1);
    expect(link.phase).toBe("closed");
  });

  test("a lost link closes without trying to write the safe state", async () => {
    const { link, port, clock } = await readyLink();
    port.unplug();
    await flush();
    const before = port.written.length;

    await clock.run(link.disconnect());
    expect(port.written.length).toBe(before);
    expect(port.isOpen).toBe(false);
  });

  test("a writer that never drains cannot stall teardown", async () => {
    const { link, port, clock } = await readyLink();
    // A device that stopped draining: `writer.close()` waits on it forever.
    const writer = (link as unknown as { writer: WritableStreamDefaultWriter<Uint8Array> }).writer;
    writer.close = () => new Promise<void>(() => {});

    await clock.run(link.disconnect());
    expect(link.phase).toBe("closed");
    expect(port.isOpen).toBe(false);
  });
});

describe("safeStateBytes", () => {
  test("zeroes each digital port, then resets", () => {
    const session = new FakeSession();
    session.feed(bytes(0x6c)); // size the table: 20 pins
    expect(Array.from(safeStateBytes(session.asSession()))).toEqual([
      0x90, 0, 0, 0x91, 0, 0, 0x92, 0, 0, FIRMATA_SYSTEM_RESET,
    ]);
  });

  test("with no pin table, only the reset", () => {
    expect(Array.from(safeStateBytes(new FakeSession().asSession()))).toEqual([FIRMATA_SYSTEM_RESET]);
  });
});
