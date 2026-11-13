import { describe, expect, test } from "bun:test";
import type { BoardState } from "@/lib/bindings/BoardState";
import {
  desktopFlashAnswer,
  FLASH_OFFER_TOAST_ID,
  watchFlashOffer,
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

const offer: BoardState = { state: "confirmFlash", port: "/dev/cu.wchusbserial1410", board: "nano" };

describe("flash offer", () => {
  test("the desktop prompt's button invokes confirm_board_flash, 'Not now' decline_board_flash", async () => {
    const calls: string[] = [];
    const store = fakeStore({ state: "connecting" });
    const { toaster, shown } = fakeToaster();
    watchFlashOffer(
      store,
      toaster,
      desktopFlashAnswer(async (command) => void calls.push(command)),
    );

    store.set(offer);
    expect(shown).toHaveLength(1);
    const [id, message, actions] = shown[0];
    expect(id).toBe(FLASH_OFFER_TOAST_ID);
    expect(message).toContain("Arduino nano");
    expect(actions.confirm.label).toBe("Flash as nano");

    actions.confirm.onClick();
    actions.decline.onClick();
    expect(calls).toEqual(["confirm_board_flash", "decline_board_flash"]);
  });

  test("is shown once per offer and withdrawn when the board state moves on", () => {
    const store = fakeStore(offer);
    const { toaster, shown, dismissed } = fakeToaster();
    const stop = watchFlashOffer(store, toaster, { confirm() {}, decline() {} });

    expect(shown).toHaveLength(1); // already offering when installed
    store.set({ ...offer });
    expect(shown).toHaveLength(1); // same offer: no second toast

    store.set({ state: "flashing", port: offer.port, board: "nano" });
    expect(dismissed).toEqual([FLASH_OFFER_TOAST_ID]);
    store.set({ state: "disconnected" });
    expect(dismissed).toHaveLength(1);

    stop();
    store.set(offer);
    expect(shown).toHaveLength(1);
  });

  test("a failed command is logged, never thrown into the click handler", async () => {
    const answer = desktopFlashAnswer(async () => {
      throw new Error("monitoring stopped");
    });
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      expect(() => answer.confirm()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.error = original;
    }
    expect(logged).toHaveLength(1);
  });
});
