// The "flash as <board>?" offer, one prompt for both hosts.
//
// When no Firmata answers and the board is only guessed from a generic
// USB-serial chip (CH340, CP210x, FTDI), the shared bring-up machine does not
// flash: both hosts put the board store in `confirmFlash`, and this module shows
// the prompt for as long as the store stays there. Only the answer differs per
// host: the browser feeds its own controller, the desktop invokes a Tauri
// command that reaches the monitor thread's board link.
//
// Every answer names the offer it answers (port + USB ids), so a stale click can
// never act on a different device: the host ignores an answer that does not
// match the offer it holds.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { BoardState } from "@/lib/bindings/BoardState";

/** The board store's offer state. */
export type FlashOffer = Extract<BoardState, { state: "confirmFlash" }>;

/** The host's two answers to an offer. */
export type FlashOfferAnswer = {
  confirm(offer: FlashOffer): void;
  decline(offer: FlashOffer): void;
};

/** The toast surface the offer needs. */
export interface OfferToaster {
  show(
    id: string,
    message: string,
    actions: {
      confirm: { label: string; onClick: () => void };
      decline: { label: string; onClick: () => void };
    },
  ): void;
  dismiss(id: string): void;
}

/** The slice of the board store the offer watches. */
export interface OfferStore {
  getState(): { board: BoardState };
  subscribe(listener: (state: { board: BoardState }) => void): () => void;
}

const FLASH_OFFER_TOAST_PREFIX = "board-flash-offer";

/** The toast id of one offer: a new offer is a new toast. */
export function flashOfferToastId(offer: FlashOffer): string {
  return `${FLASH_OFFER_TOAST_PREFIX}:${offer.port}:${offer.vid}:${offer.pid}:${offer.board}`;
}

export function flashOfferMessage(offer: FlashOffer): string {
  return (
    `No Firmata answered on ${offer.port}. This device uses a generic USB-serial chip, so ` +
    `it may be an Arduino ${offer.board}, or something else entirely. Flashing replaces ` +
    `its firmware.`
  );
}

/** "Flash as nano on /dev/cu.wchusbserial2420" — names the device it will rewrite. */
export function flashOfferLabel(offer: FlashOffer): string {
  return `Flash as ${offer.board} on ${offer.port}`;
}

/**
 * Show the offer while the store says `confirmFlash` and withdraw it when the
 * store moves on (answered, unplugged, device changed). A different offer
 * replaces the toast. Returns the unsubscribe.
 */
export function watchFlashOffer(
  store: OfferStore,
  toaster: OfferToaster,
  answer: FlashOfferAnswer,
): () => void {
  let shown: string | null = null;
  const sync = (board: BoardState) => {
    const next = board.state === "confirmFlash" ? flashOfferToastId(board) : null;
    if (next === shown) return;
    if (shown !== null) toaster.dismiss(shown);
    shown = next;
    if (board.state !== "confirmFlash" || next === null) return;
    const offer = board;
    toaster.show(next, flashOfferMessage(offer), {
      confirm: { label: flashOfferLabel(offer), onClick: () => answer.confirm(offer) },
      decline: { label: "Not now", onClick: () => answer.decline(offer) },
    });
  };
  sync(store.getState().board);
  return store.subscribe((state) => sync(state.board));
}

/** The offer as a sonner toast: it stays until answered or withdrawn. */
export const sonnerOfferToaster: OfferToaster = {
  show: (id, message, { confirm, decline }) => {
    toast.warning(message, {
      id,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      action: confirm,
      cancel: decline,
    });
  },
  dismiss: (id) => {
    toast.dismiss(id);
  },
};

type Invoke = (command: string, args: { port: string; vid: number; pid: number }) => Promise<unknown>;

/** The desktop's answers: Tauri commands the monitor thread drains next tick. */
export function desktopFlashAnswer(
  call: Invoke = (command, args) => invoke(command, args),
): FlashOfferAnswer {
  const send = (command: string, { port, vid, pid }: FlashOffer) => {
    call(command, { port, vid, pid }).catch((error: unknown) => {
      console.error(`[flash-offer] ${command} failed:`, error);
    });
  };
  return {
    confirm: (offer) => send("confirm_board_flash", offer),
    decline: (offer) => send("decline_board_flash", offer),
  };
}
