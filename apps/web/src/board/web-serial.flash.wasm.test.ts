// The browser's flash executor (`runFlash`) against a fake Web Serial port,
// driven by the *compiled* flash drivers (`microflow_core::flasher` as wasm),
// not a TS copy of them. The drivers rely on what an executor does with each
// step (the contract in `flasher/driver.rs`): discard the input before a
// command unless the step keeps it, hand back a short read as it is, close the
// port before opening it again. The desktop executor is held to that by its
// transcripts (`src-tauri/src/flasher/tests.rs`); this holds the browser's to
// it, on the same exchanges.
//
// Time is a `FakeClock`: the board answers on it, and the executor's waits run
// on it, so a slow link or a silent board costs no real time.
//
// Needs the generated module: `bun run build:wasm:firmata`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FlashSession, initSync } from "./generated/microflow_firmata_wasm.js";
import { FakeClock, FakeSerial, FakeSerialPort } from "./link-fakes";
import type { WebSerialOptions, WebSerialSignals } from "./serial-port";
import { runFlash } from "./web-serial";

initSync({
  module: readFileSync(new URL("./generated/microflow_firmata_wasm_bg.wasm", import.meta.url)),
});

// `runFlash` narrates every command to the console; keep the test output clean.
const realConsole = { debug: console.debug, warn: console.warn };
beforeAll(() => {
  console.debug = () => {};
  console.warn = () => {};
});
afterAll(() => {
  console.debug = realConsole.debug;
  console.warn = realConsole.warn;
});

// --- The board at the other end ---------------------------------------------

const hex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

/** A flash image of `len` bytes in which every page is different (the desktop
 *  tests' image). */
function image(len: number): Uint8Array {
  return Uint8Array.from({ length: len }, (_, i) => (i * 7 + Math.floor(i / 128) + 3) & 0xff);
}

/** How a board answers one written chunk: by calling `port.emit`, now or later. */
type Answer = (written: Uint8Array, port: FlashPort) => void;

/** A fake Web Serial port that logs what the executor does to it, in order. */
class FlashPort extends FakeSerialPort {
  readonly log: string[] = [];
  /** Called when the executor sets the control lines. */
  onSignals: (signals: WebSerialSignals) => void = () => {};
  /** Make `setSignals` reject, as an adapter without DTR/RTS does. */
  signalsFail = false;

  constructor(private readonly answer: Answer) {
    super({ respond: () => [] });
  }

  override async open(options: WebSerialOptions): Promise<void> {
    await super.open(options);
    this.log.push(`open @${options.baudRate}`);
    // As Web Serial does, the port lets go of its writable once that is
    // closed (the executor closes its writer rather than releasing it); a
    // stream still locked by a reader or an open writer makes `close` reject.
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.log.push(`tx ${hex(chunk)}`);
        this.answer(chunk, this);
      },
      close: () => {
        this.writable = null;
      },
    });
  }

  override async close(): Promise<void> {
    await super.close();
    this.log.push("close");
  }

  override async setSignals(signals: WebSerialSignals = {}): Promise<void> {
    if (this.signalsFail) throw new DOMException("Failed to set control signals.", "NetworkError");
    this.log.push(`dtr ${Number(signals.dataTerminalReady)} rts ${Number(signals.requestToSend)}`);
    this.onSignals(signals);
  }

  /** The commands written, without the page data. */
  get commands(): string[] {
    return this.log.filter((line) => line.startsWith("tx ")).map((line) => line.slice(3, 14).trim());
  }
}

/** The `tx`/`rx` lines of a desktop transcript as what a board answers to
 *  each command; `image[a..b]` stands for those bytes of `flash`. */
function exchange(transcript: string, flash: Uint8Array): Map<string, Uint8Array> {
  const bytes = (line: string) =>
    line
      .split(" ")
      .flatMap((token) => {
        const range = /^image\[(\d+)\.\.(\d+)\]$/.exec(token);
        if (range) return Array.from(flash.subarray(Number(range[1]), Number(range[2])));
        return [Number.parseInt(token, 16)];
      });
  const answers = new Map<string, Uint8Array>();
  let command = "";
  for (const line of transcript.trim().split("\n").map((l) => l.trim())) {
    if (line.startsWith("tx ")) {
      command = hex(bytes(line.slice(3)));
      answers.set(command, new Uint8Array(0));
    } else if (line.startsWith("rx ")) {
      answers.set(command, Uint8Array.from(bytes(line.slice(3))));
    }
  }
  return answers;
}

type Link = {
  /** How long the bootloader reads nothing after its reset (Optiboot flashes
   *  its LED for 375 ms); what was written meanwhile is answered then. */
  bootMs?: number;
  /** How long an answer is on its way. */
  delayMs?: number;
  /** Deliver an answer in pieces of this many bytes… */
  pieceLen?: number;
  /** …this far apart. */
  pieceGapMs?: number;
};

/** A bootloader that answers each command as `answers` says, over `link`. A
 *  command it does not know is left unanswered and noted in `unknown`. */
function bootloader(clock: FakeClock, answers: Map<string, Uint8Array>, link: Link = {}) {
  const unknown: string[] = [];
  let readsFrom = 0;
  /** The board was reset (DTR asserted). */
  const reset = () => {
    readsFrom = clock.now() + (link.bootMs ?? 0);
  };
  const answer: Answer = (written, port) => {
    const reply = answers.get(hex(written));
    if (!reply) {
      unknown.push(hex(written));
      return;
    }
    const sentIn = Math.max(readsFrom - clock.now(), 0) + (link.delayMs ?? 0);
    const pieceLen = link.pieceLen ?? Math.max(reply.length, 1);
    for (let at = 0, piece = 0; at < reply.length; at += pieceLen, piece += 1) {
      const bytes = reply.slice(at, at + pieceLen);
      clock.setTimer(() => port.emit(bytes), sentIn + piece * (link.pieceGapMs ?? 0));
    }
  };
  return { answer, reset, unknown };
}

// The exchanges of the desktop golden transcripts
// (`src-tauri/src/flasher/tests.rs`), for the same images.

const UNO = `
  tx 30 20
  rx 14 10
  tx 75 20
  rx 14 1E 95 0F 10
  tx 50 20
  rx 14 10
  tx 55 00 00 20
  rx 14 10
  tx 64 00 80 46 image[0..128] 20
  rx 14 10
  tx 55 40 00 20
  rx 14 10
  tx 64 00 80 46 image[128..256] 20
  rx 14 10
  tx 55 80 00 20
  rx 14 10
  tx 64 00 2C 46 image[256..300] 20
  rx 14 10
  tx 51 20
  rx 14 10`;

const MEGA = `
  tx 1B 01 00 01 0E 01 14
  rx 1B 01 00 0B 0E 01 00 08 41 56 52 49 53 50 5F 32 74
  tx 1B 02 00 0C 0E 10 C8 64 19 20 00 53 03 AC 53 00 00 31
  rx 1B 02 00 02 0E 10 00 05
  tx 1B 03 00 06 0E 1B 04 30 00 00 00 3F
  rx 1B 03 00 04 0E 1B 00 1E 00 17
  tx 1B 04 00 06 0E 1B 04 30 00 01 00 39
  rx 1B 04 00 04 0E 1B 00 98 00 96
  tx 1B 05 00 06 0E 1B 04 30 00 02 00 3B
  rx 1B 05 00 04 0E 1B 00 01 00 0E
  tx 1B 06 00 05 0E 06 00 00 00 00 10
  rx 1B 06 00 02 0E 06 00 17
  tx 1B 07 01 0A 0E 13 01 00 C1 0A 40 4C 20 00 00 image[0..256] 6C
  rx 1B 07 00 02 0E 13 00 03
  tx 1B 08 00 05 0E 06 00 00 00 80 9E
  rx 1B 08 00 02 0E 06 00 19
  tx 1B 09 01 0A 0E 13 01 00 C1 0A 40 4C 20 00 00 image[256..512] 62
  rx 1B 09 00 02 0E 13 00 0D
  tx 1B 0A 00 05 0E 06 00 00 01 00 1D
  rx 1B 0A 00 02 0E 06 00 1B
  tx 1B 0B 00 62 0E 13 00 58 C1 0A 40 4C 20 00 00 image[512..600] 10
  rx 1B 0B 00 02 0E 13 00 0F
  tx 1B 0C 00 03 0E 11 01 01 0B
  rx 1B 0C 00 02 0E 11 00 0A`;

const LEONARDO = `
  tx 53
  rx 43 41 54 45 52 49 4E
  tx 65
  rx 0D
  tx 41 00 00
  rx 0D
  tx 42 00 80 46 image[0..128]
  rx 0D
  tx 42 00 80 46 image[128..256]
  rx 0D
  tx 42 00 2C 46 image[256..300]
  rx 0D
  tx 45`;

/** The `tx` lines of a transcript, with the page data written out. */
function writes(transcript: string, flash: Uint8Array): string[] {
  return [...exchange(transcript, flash).keys()].map((command) => `tx ${command}`);
}

/** Flash `flash` as `board` through `runFlash`, on the fake clock. Resolves
 *  with the progress reported, or rejects with the flash's error. */
async function flashOn(
  clock: FakeClock,
  serial: FakeSerial,
  port: FlashPort,
  board: string,
  baud: number,
  flash: Uint8Array,
): Promise<Array<[number, number]>> {
  const session = new FlashSession(board, flash);
  const progress: Array<[number, number]> = [];
  // Settled as a value: the clock is run until the flash ends either way.
  const failure = await clock.run(
    runFlash({ serial, clock }, port, baud, session, (done, total) => progress.push([done, total])).then(
      () => null,
      (error: unknown) => error,
    ),
  );
  session.free();
  if (failure) throw failure;
  return progress;
}

/** An Uno behind `link` whose bootloader answers as the golden transcript says. */
function uno(link: Link = {}) {
  const clock = new FakeClock();
  const flash = image(300);
  const boot = bootloader(clock, exchange(UNO, flash), link);
  const port = new FlashPort(boot.answer);
  port.onSignals = ({ dataTerminalReady }) => {
    if (dataTerminalReady) boot.reset();
  };
  const run = () => flashOn(clock, new FakeSerial([port]), port, "uno", 115_200, flash);
  return { clock, flash, boot, port, run };
}

/** A Mega 2560 behind `link`, likewise. */
function mega(link: Link = {}) {
  const clock = new FakeClock();
  const flash = image(600);
  const boot = bootloader(clock, exchange(MEGA, flash), link);
  const port = new FlashPort(boot.answer);
  const run = () => flashOn(clock, new FakeSerial([port]), port, "mega", 115_200, flash);
  return { clock, flash, boot, port, run };
}

// --- A whole flash per protocol ---------------------------------------------

describe("runFlash carries a whole flash out as the desktop executor does", () => {
  test("an Uno (STK500v1) is reset, synced and programmed page by page", async () => {
    const { flash, boot, port, run } = uno();

    const progress = await run();

    expect(port.log).toEqual([
      "open @115200",
      "dtr 0 rts 0",
      "dtr 1 rts 1",
      ...writes(UNO, flash),
      "close",
    ]);
    expect(boot.unknown).toEqual([]);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(port.isOpen).toBe(false);
  });

  test("a Mega (STK500v2) is reset, signed on and programmed page by page", async () => {
    const { flash, boot, port, run } = mega();

    const progress = await run();

    expect(port.log).toEqual([
      "open @115200",
      "dtr 0 rts 0",
      "dtr 1 rts 1",
      ...writes(MEGA, flash),
      "close",
    ]);
    expect(boot.unknown).toEqual([]);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  test("a Leonardo (AVR109) is touched at 1200 baud, found again on its bootloader's port and programmed", async () => {
    const clock = new FakeClock();
    const flash = image(300);
    const boot = bootloader(clock, exchange(LEONARDO, flash));
    // The sketch's port answers nothing; the bootloader shows up as another.
    const sketchPort = new FlashPort(() => {});
    const bootloaderPort = new FlashPort(boot.answer);
    const serial = new FakeSerial([sketchPort, bootloaderPort]);

    const progress = await flashOn(clock, serial, sketchPort, "leonardo", 57_600, flash);

    // Closed before it is opened again at the touch rate, and let go of
    // before the bootloader's port is opened.
    expect(sketchPort.log).toEqual(["open @57600", "close", "open @1200", "dtr 0 rts 0", "close"]);
    expect(bootloaderPort.log).toEqual(["open @57600", ...writes(LEONARDO, flash), "close"]);
    expect(boot.unknown).toEqual([]);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(sketchPort.isOpen).toBe(false);
    expect(bootloaderPort.isOpen).toBe(false);
  });
});

// --- What a Transact does with the input ------------------------------------

describe("runFlash discards the input before a command, unless the step keeps it", () => {
  test("bytes that came in before the first sync was written are not read as its answer", async () => {
    const { boot, port, run } = uno();
    // What looks like a sync answer arrives while the board is being reset.
    port.onSignals = ({ dataTerminalReady }) => {
      if (dataTerminalReady) port.emit(Uint8Array.of(0x14, 0x10));
    };

    await run();

    expect(boot.unknown).toEqual([]);
    expect(port.commands.slice(0, 3)).toEqual(["30 20", "75 20", "50 20"]);
  });

  test("a stray byte behind one answer is not read as the start of the next", async () => {
    const clock = new FakeClock();
    const flash = image(300);
    const answers = exchange(UNO, flash);
    answers.set("75 20", Uint8Array.of(0x14, 0x1e, 0x95, 0x0f, 0x10, 0x00));
    const boot = bootloader(clock, answers);
    const port = new FlashPort(boot.answer);

    const progress = await flashOn(clock, new FakeSerial([port]), port, "uno", 115_200, flash);

    expect(progress.at(-1)).toEqual([3, 3]);
  });

  test("an answer that comes in after the command was repeated is kept, and the flash goes through", async () => {
    // Every answer 300 ms late: the answer to the first sign-on comes in after
    // the second went out (they are 250 ms apart), and the answer to the
    // second ahead of the answer to "enter programming mode".
    const { clock, boot, port, run } = mega({ delayMs: 300 });

    const progress = await run();

    expect(port.commands.slice(0, 4)).toEqual(["1B 01 00 01", "1B 01 00 01", "1B 02 00 0C", "1B 03 00 06"]);
    expect(boot.unknown).toEqual([]);
    expect(progress.at(-1)).toEqual([3, 3]);
    // 0.35 s of reset, then the first sign-on's answer and those of the
    // eleven commands after it, each 300 ms late (give or take the executor's
    // 10 ms poll). The repeated sign-on costs no time.
    expect(clock.now()).toBeGreaterThanOrEqual(350 + 12 * 300);
    expect(clock.now()).toBeLessThan(350 + 12 * 310);
  });

  test("the same on an Uno: a late sync answer is kept, and the one behind it is not read as the signature", async () => {
    // Optiboot answers the first sync 375 ms after its reset; 300 ms more on
    // the link, and that answer comes in after the second sync went out (they
    // are 550 ms apart). The answer to the second comes in ahead of the
    // signature.
    const { boot, port, run } = uno({ bootMs: 375, delayMs: 300 });

    const progress = await run();

    expect(port.commands.slice(0, 4)).toEqual(["30 20", "30 20", "75 20", "50 20"]);
    expect(boot.unknown).toEqual([]);
    expect(progress.at(-1)).toEqual([3, 3]);
  });
});

// --- How an answer arrives ---------------------------------------------------

describe("runFlash reads an answer however it arrives", () => {
  test("an answer split across chunks is put together", async () => {
    // Three bytes at a time, 4 ms apart: a sign-on answer takes six chunks
    // and straddles two of the executor's polls.
    const { boot, port, run } = mega({ pieceLen: 3, pieceGapMs: 4 });

    const progress = await run();

    expect(boot.unknown).toEqual([]);
    expect(port.commands.filter((command) => command === "1B 01 00 01")).toHaveLength(1);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  test("a board that never answers fails the flash when the driver's waits are over, and the port is closed", async () => {
    const clock = new FakeClock();
    const port = new FlashPort(() => {});

    const flashing = flashOn(clock, new FakeSerial([port]), port, "mega", 115_200, image(600));

    await expect(flashing).rejects.toThrow("Failed to sync with bootloader");
    // 0.35 s of reset, then five sign-ons, each waited for 250 ms.
    expect(clock.now()).toBe(350 + 5 * 250);
    expect(port.commands).toEqual(Array.from({ length: 5 }, () => "1B 01 00 01"));
    expect(port.log.at(-1)).toBe("close");
    expect(port.isOpen).toBe(false);
  });

  test("a sketch that keeps printing does not stretch a wait: each transact has one deadline, however the bytes trickle in", async () => {
    // A board that never resets into its bootloader, whose sketch prints two
    // bytes every 540 ms: each pair comes in just inside a 550 ms wait. Read
    // by read, that would be another wait each time; one deadline per step,
    // and the sync fails at most one wait per baud later than on a silent
    // board (three bauds, 0.35 s of reset and eight 550 ms waits each).
    const clock = new FakeClock();
    const port = new FlashPort(() => {});
    const talk = () => {
      port.emit(new TextEncoder().encode("ok"));
      clock.setTimer(talk, 540);
    };
    clock.setTimer(talk, 540);

    const flashing = flashOn(clock, new FakeSerial([port]), port, "uno", 115_200, image(300));

    await expect(flashing).rejects.toThrow("Failed to sync with bootloader");
    expect(clock.now()).toBeLessThanOrEqual(3 * (350 + 8 * 550) + 3 * 550);
    expect(port.isOpen).toBe(false);
  });

  test("an answer that stops short is handed to the driver as it is, which fails the flash before anything is programmed", async () => {
    const clock = new FakeClock();
    const flash = image(300);
    const answers = exchange(UNO, flash);
    answers.set("75 20", Uint8Array.of(0x14, 0x1e, 0x95));
    const port = new FlashPort(bootloader(clock, answers).answer);

    const flashing = flashOn(clock, new FakeSerial([port]), port, "uno", 115_200, flash);

    await expect(flashing).rejects.toThrow("Invalid signature response: [14, 1E, 95]");
    expect(port.commands).toEqual(["30 20", "75 20"]);
    expect(port.isOpen).toBe(false);
  });
});

// --- The control lines --------------------------------------------------------

describe("runFlash and an adapter that cannot set DTR/RTS", () => {
  test("the flash goes on: whether the board reset shows in whether it syncs", async () => {
    const { port, run } = uno();
    port.signalsFail = true;

    const progress = await run();

    expect(progress.at(-1)).toEqual([3, 3]);
  });
});
