// The song the editor is working on, before it is saved: the notes in playing
// order, each under an id that stays with it while notes around it are added,
// removed and reordered (the list key, and what drag and drop names a note
// by). Every edit returns a new draft; a node's stored song is `songOf` one.

import { uid } from "@/lib/uid";

export type SongDraft<N> = readonly { readonly id: string; readonly note: N }[];

/** A draft of `song`, to edit. */
export function draftOf<N>(song: readonly N[]): SongDraft<N> {
  return song.map((note) => ({ id: uid(), note }));
}

/** The song a draft has become: its notes in order, as the node stores them. */
export function songOf<N>(draft: SongDraft<N>): N[] {
  return draft.map(({ note }) => note);
}

/** `draft` with `note` as its new last note. */
export function added<N>(draft: SongDraft<N>, note: N): SongDraft<N> {
  return [...draft, { id: uid(), note }];
}

/** `draft` without the note `id`. */
export function removed<N>(draft: SongDraft<N>, id: string): SongDraft<N> {
  return draft.filter((entry) => entry.id !== id);
}

/** `draft` with the note `id` replaced by `note`, in the same place. */
export function replaced<N>(draft: SongDraft<N>, id: string, note: N): SongDraft<N> {
  return draft.map((entry) => (entry.id === id ? { id, note } : entry));
}

/** `draft` with the notes `id` and `otherId` in each other's place. Unchanged
 *  when either is not in it. */
export function swapped<N>(draft: SongDraft<N>, id: string, otherId: string): SongDraft<N> {
  const left = draft.findIndex((entry) => entry.id === id);
  const right = draft.findIndex((entry) => entry.id === otherId);
  if (left === -1 || right === -1) return draft;
  const next = [...draft];
  next[left] = draft[right]!;
  next[right] = draft[left]!;
  return next;
}
