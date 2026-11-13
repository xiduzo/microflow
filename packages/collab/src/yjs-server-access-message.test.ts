import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";

import { YjsServer } from "./yjs-server";
import { MemoryRoomStore, type RoomStore } from "./room-store";
import {
  ACCESS_CODES,
  MESSAGE_ACCESS,
  MESSAGE_ACK,
  MESSAGE_SYNC,
  MESSAGE_UNSAVED,
  UNSAVED_REASONS,
} from "./protocol";

/**
 * `MESSAGE_ACCESS` is how a client learns what the room will accept from it.
 * Without it a demotion is silent: the room drops the writes, the editor keeps
 * accepting them, and the two documents drift.
 */

async function join(server: YjsServer, userId: string, canWrite: boolean) {
  const received: Uint8Array[] = [];
  await server.join("flow-1", { send: (d) => received.push(d), close: () => {} }, userId, canWrite);
  return {
    received,
    accessFrames(): string[] {
      return received.flatMap((frame) => {
        const decoder = decoding.createDecoder(frame);
        if (decoding.readVarUint(decoder) !== MESSAGE_ACCESS) return [];
        return [ACCESS_CODES[decoding.readVarUint(decoder)]!];
      });
    },
  };
}

describe("YjsServer access message", () => {
  test("join states the granted access", async () => {
    const server = new YjsServer({ store: new MemoryRoomStore() });
    const editor = await join(server, "editor", true);
    const viewer = await join(server, "viewer", false);

    expect(editor.accessFrames()).toEqual(["write"]);
    expect(viewer.accessFrames()).toEqual(["read"]);
  });

  test("setAccess tells the affected connection, and only it", async () => {
    const server = new YjsServer({ store: new MemoryRoomStore() });
    const demoted = await join(server, "bob", true);
    const bystander = await join(server, "carol", true);

    server.setAccess("flow-1", "bob", "read");
    server.setAccess("flow-1", "bob", "write");

    expect(demoted.accessFrames()).toEqual(["write", "read", "write"]);
    expect(bystander.accessFrames()).toEqual(["write"]);
  });
});

describe("YjsServer join-time ack", () => {
  const acks = (received: Uint8Array[]) =>
    received.filter((frame) => decoding.readVarUint(decoding.createDecoder(frame)) === MESSAGE_ACK);

  test("a clean room acknowledges on join, so a returning client stops waiting for a missed ack", async () => {
    const server = new YjsServer({ store: new MemoryRoomStore() });
    const peer = await join(server, "ada", true);
    expect(acks(peer.received).length).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// Durability signals: ack only when settled, "unsaved" otherwise.
// ----------------------------------------------------------------------------

/** A store whose saves wait for the test to release (or fail) them. */
class GatedStore implements RoomStore {
  private pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  saves = 0;
  async load(): Promise<Uint8Array | null> {
    return null;
  }
  save(): Promise<void> {
    this.saves++;
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  release(): void {
    this.pending.shift()?.resolve();
  }
  fail(): void {
    this.pending.shift()?.reject(new Error("store unavailable"));
  }
}

function edit(key: string): Uint8Array {
  const client = new Y.Doc();
  client.getMap("nodes").set(key, 1);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client));
  return encoding.toUint8Array(encoder);
}

type Signal = "ack" | "unsaved:pending" | "unsaved:failed";

async function joinPeer(server: YjsServer, userId: string) {
  const received: Uint8Array[] = [];
  const connection = await server.join(
    "flow-1",
    { send: (d) => received.push(d), close: () => {} },
    userId,
    true,
  );
  return {
    connection,
    signals(): Signal[] {
      return received.flatMap((frame): Signal[] => {
        const decoder = decoding.createDecoder(frame);
        const type = decoding.readVarUint(decoder);
        if (type === MESSAGE_ACK) return ["ack"];
        if (type === MESSAGE_UNSAVED) {
          return [`unsaved:${UNSAVED_REASONS[decoding.readVarUint(decoder)]}` as Signal];
        }
        return [];
      });
    },
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("YjsServer durability signals", () => {
  test("joining a dirty room (save not yet due) gets 'unsaved', not an ack", async () => {
    const store = new GatedStore();
    const server = new YjsServer({ store, persistDebounce: 10_000, persistMaxWait: 10_000 });
    const writer = await joinPeer(server, "ada");
    writer.connection.receive(edit("a"));

    const joiner = await joinPeer(server, "bob");
    expect(joiner.signals()).toEqual(["unsaved:pending"]);
  });

  test("joining mid-save gets 'unsaved'; the save's ack follows", async () => {
    const store = new GatedStore();
    const server = new YjsServer({ store, persistDebounce: 5, persistMaxWait: 50 });
    const writer = await joinPeer(server, "ada");
    writer.connection.receive(edit("a"));
    await tick(20);
    expect(store.saves).toBe(1); // in flight

    const joiner = await joinPeer(server, "bob");
    expect(joiner.signals()).toEqual(["unsaved:pending"]);

    store.release();
    await tick();
    expect(joiner.signals()).toEqual(["unsaved:pending", "ack"]);
  });

  test("a save that lands with newer edits pending is not acked", async () => {
    const store = new GatedStore();
    const server = new YjsServer({ store, persistDebounce: 5, persistMaxWait: 50 });
    const writer = await joinPeer(server, "ada");
    const before = writer.signals().length;
    writer.connection.receive(edit("a"));
    await tick(20);

    writer.connection.receive(edit("b")); // lands while "a" is being written
    store.release();
    await tick();
    expect(writer.signals().slice(before)).toEqual([]);

    await tick(20); // the follow-up save, carrying "b"
    store.release();
    await tick();
    expect(writer.signals().slice(before)).toEqual(["ack"]);
  });

  test("a failed save withdraws the ack from the room", async () => {
    const store = new GatedStore();
    const server = new YjsServer({
      store,
      persistDebounce: 5,
      persistMaxWait: 50,
      persistRetryBase: 10_000,
    });
    const writer = await joinPeer(server, "ada");
    const before = writer.signals().length;
    writer.connection.receive(edit("a"));
    await tick(20);

    store.fail();
    await tick();
    expect(writer.signals().slice(before)).toEqual(["unsaved:failed"]);
  });
});
