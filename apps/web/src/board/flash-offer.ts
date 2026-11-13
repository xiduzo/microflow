// The "flash as <board>?" offer, one prompt for both hosts.
//
// When no Firmata answers and the board is only guessed from a generic
// USB-serial chip (CH340, CP210x, FTDI), the shared bring-up machine does not
// flash: both hosts put the board store in `confirmFlash`, and this module shows
// the prompt for as long as the store stays there. Only the answer differs per
// host: the browser feeds its own controller, the desktop invokes a Tauri
// command that reaches the monitor thread's board link.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { BoardState } from "@/lib/bindings/BoardState";

/** The host's two answers to the offer. */
export type FlashOfferAnswer = { confirm(): void; decline(): void };

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

export const FLASH_OFFER_TOAST_ID = "board-flash-offer";

export function flashOfferMessage(board: string): string {
  return (
    `No Firmata answered. This device uses a generic USB-serial chip, so it may be ` +
    `an Arduino ${board}, or something else entirely. Flashing replaces its firmware.`
  );
}

/**
 * Show the offer while the store says `confirmFlash` and withdraw it when the
 * store moves on (answered, unplugged, another port took over). Returns the
 * unsubscribe.
 */
export function watchFlashOffer(
  store: OfferStore,
  toaster: OfferToaster,
  answer: FlashOfferAnswer,
): () => void {
  let shown: string | null = null;
  const sync = (board: BoardState) => {
    if (board.state === "confirmFlash") {
      const key = `${board.port}\u0000${board.board}`;
      if (shown === key) return;
      shown = key;
      toaster.show(FLASH_OFFER_TOAST_ID, flashOfferMessage(board.board), {
        confirm: { label: `Flash as ${board.board}`, onClick: answer.confirm },
        decline: { label: "Not now", onClick: answer.decline },
      });
    } else if (shown !== null) {
      shown = null;
      toaster.dismiss(FLASH_OFFER_TOAST_ID);
    }
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

/** The desktop's answers: Tauri commands the monitor thread drains next tick. */
export function desktopFlashAnswer(
  call: (command: string) => Promise<unknown> = (command) => invoke(command),
): FlashOfferAnswer {
  const send = (command: string) => {
    call(command).catch((error: unknown) => {
      console.error(`[flash-offer] ${command} failed:`, error);
    });
  };
  return {
    confirm: () => send("confirm_board_flash"),
    decline: () => send("decline_board_flash"),
  };
}
