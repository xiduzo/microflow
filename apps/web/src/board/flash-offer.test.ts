import { describe, expect, test } from "bun:test";
import type { BoardState } from "@/lib/bindings/BoardState";
import {
  desktopFlashAnswer,
  flashOfferToastId,
  watchFlashOffer,
  type FlashOffer,
  type OfferStore,
  type OfferToaster,
} from "./flash-offer";

function fakeStore(initial: BoardState) {
  let board = initial;
  const listeners = new Set<(state: { board: BoardState }) => void>();
  const store: OfferStore & { set(next: BoardState): void } = {
    getState: () => ({ board }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      board = next;
      for (const listener of listeners) listener({ board });
    },
  };
  return store;
}

type Shown = Parameters<OfferToaster["show"]>;

function fakeToaster() {
  const shown: Shown[] = [];
  const dismissed: string[] = [];
  const toaster: OfferToaster = {
    show: (...args) => void shown.push(args),
    dismiss: (id) => void dismissed.push(id),
  };
  return { toaster, shown, dismissed };
}

const offer: FlashOffer = {
  state: "confirmFlash",
  port: "/dev/cu.wchusbserial1410",
  board: "nano",
  vid: 0x1a86,
  pid: 0x7523,
};
const otherOffer: FlashOffer = { ...offer, port: "/dev/cu.wchusbserial2420" };

describe("flash offer", () => {
  test("the desktop prompt invokes the commands with the offer it answers", () => {
    const calls: Array<[string, unknown]> = [];
    const store = fakeStore({ state: "connecting" });
    const { toaster, shown } = fakeToaster();
    watchFlashOffer(
      store,
      toaster,
      desktopFlashAnswer(async (command, args) => void calls.push([command, args])),
    );

    store.set(offer);
    expect(shown).toHaveLength(1);
    const [id, message, actions] = shown[0];
    expect(id).toBe(flashOfferToastId(offer));
    expect(message).toContain("Arduino nano");
    expect(message).toContain(offer.port);
    expect(actions.confirm.label).toBe("Flash as nano on /dev/cu.wchusbserial1410");

    actions.confirm.onClick();
    actions.decline.onClick();
    const identity = { port: offer.port, vid: 0x1a86, pid: 0x7523 };
    expect(calls).toEqual([
      ["confirm_board_flash", identity],
      ["decline_board_flash", identity],
    ]);
  });

  test("is shown once per offer, replaced by a different offer, withdrawn when the state moves on", () => {
    const store = fakeStore(offer);
    const { toaster, shown, dismissed } = fakeToaster();
    const stop = watchFlashOffer(store, toaster, { confirm() {}, decline() {} });

    expect(shown).toHaveLength(1); // already offering when installed
    store.set({ ...offer });
    expect(shown).toHaveLength(1); // same offer: no second toast

    store.set(otherOffer);
    expect(dismissed).toEqual([flashOfferToastId(offer)]);
    expect(shown.map(([id]) => id)).toEqual([flashOfferToastId(offer), flashOfferToastId(otherOffer)]);

    store.set({ state: "disconnected" });
    expect(dismissed).toEqual([flashOfferToastId(offer), flashOfferToastId(otherOffer)]);

    // The same offer coming back after a withdrawal is shown again.
    store.set(offer);
    expect(shown).toHaveLength(3);

    stop();
    store.set(otherOffer);
    expect(shown).toHaveLength(3);
  });

  test("a failed command is logged, never thrown into the click handler", async () => {
    const answer = desktopFlashAnswer(async () => {
      throw new Error("monitoring stopped");
    });
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      expect(() => answer.confirm(offer)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.error = original;
    }
    expect(logged).toHaveLength(1);
  });
});
