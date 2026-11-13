/**
 * Wire message types, shared by the client provider and `YjsServer`.
 *
 * The numbering is **not ours to choose freely**. The client is
 * `y-websocket`'s `WebsocketProvider`, which dispatches inbound frames through
 * a `messageHandlers` array indexed by this number and reserves 0–3:
 *
 * | # | y-websocket        |
 * |---|--------------------|
 * | 0 | `messageSync`      |
 * | 1 | `messageAwareness` |
 * | 2 | `messageAuth`      |
 * | 3 | `messageQueryAwareness` |
 *
 * Anything we add must sit above that range. `MESSAGE_ACK` used to be 2, which
 * collided with `messageAuth`: the provider would have handed our persistence
 * acknowledgement to `readAuthMessage` and read the version number as a
 * permission-denied frame. Keep new message types climbing from 4, and leave
 * room in case y-protocols claims more.
 */

/** Yjs document sync (`y-protocols/sync`). Reserved by y-websocket. */
export const MESSAGE_SYNC = 0;
/** Awareness/presence (`y-protocols/awareness`). Reserved by y-websocket. */
export const MESSAGE_AWARENESS = 1;
/** Permission denied (`y-protocols/auth`). Reserved by y-websocket. */
export const MESSAGE_AUTH = 2;
/** Awareness state request. Reserved by y-websocket. */
export const MESSAGE_QUERY_AWARENESS = 3;

/**
 * Ours: the server telling the room its document reached durable storage,
 * carrying the persist timestamp as a varUint.
 */
export const MESSAGE_ACK = 4;

/**
 * Close codes in 4400–4499 tell `WebsocketProvider` not to reconnect
 * (`defaultShouldReconnect`). Use this when the answer will not change by
 * trying again — the user was never authorized, or their access was revoked
 * mid-session — so a removed collaborator stops hammering the server.
 */
export const CLOSE_ACCESS_DENIED = 4401;

/**
 * Terminal (4400–4499): the flow was deleted. Sent when a join races
 * `flow.delete` — reconnecting would only find the flow missing again.
 */
export const CLOSE_FLOW_GONE = 4404;

/**
 * Ours: the server telling one connection what it may do with the room,
 * carrying an `ACCESS_CODES` entry as a varUint.
 *
 * Sent on join and whenever `YjsServer.setAccess` changes a live
 * connection's write bit. Without it a demoted collaborator keeps editing a
 * document whose writes the room now drops, and the two copies drift apart in
 * silence. Clients that predate this message log y-websocket's "Unable to
 * compute message" and otherwise ignore it.
 */
export const MESSAGE_ACCESS = 5;

/** Wire encoding for `MESSAGE_ACCESS`. Index = code. */
export const ACCESS_CODES = ["none", "read", "write"] as const;
export type WireAccess = (typeof ACCESS_CODES)[number];

/**
 * Ours: the room holds changes that are not durably stored. It withdraws any
 * earlier `MESSAGE_ACK` — a client showing "Saved" goes back to "Saving"
 * until the next ack. Carries an `UNSAVED_REASONS` index as a varUint:
 * `pending` to a client joining a room with a save due or in flight,
 * `failed` to the room when a persist fails (the room retries with backoff).
 */
export const MESSAGE_UNSAVED = 6;
export const UNSAVED_REASONS = ["pending", "failed"] as const;
export type UnsavedReason = (typeof UNSAVED_REASONS)[number];

/**
 * Terminal (4400–4499): the authenticated user may not open this flow — the
 * auth gate's denial. Kept apart from a failure while *deciding* (a database
 * timeout, an unready pool), which closes with `CLOSE_INTERNAL_ERROR` and is
 * retried: otherwise one deploy hiccup strands every client in "access lost".
 */
export const CLOSE_FORBIDDEN = 4403;

/**
 * The auth gate's "no valid session" close: RFC 6455 "policy violation",
 * reason "Unauthorized". Older servers also sent it, reason "Forbidden", for
 * denials *and* for database errors while checking access — so the client
 * treats every 1008 as `"reauth"`: a few bounded retries, then stop.
 */
export const CLOSE_POLICY_VIOLATION = 1008;

/**
 * RFC 6455 "internal error". Retryable: the server could not decide or load
 * (store or database failure), and asking again later may well succeed.
 */
export const CLOSE_INTERNAL_ERROR = 1011;

/**
 * Standard WebSocket "Service Restart" (RFC 6455 registry). The server sends
 * it from `YjsServer.shutdown()` when the process is going down. Retryable on
 * purpose: the client reconnects to the next instance and re-sends, as sync
 * step 2, anything the store lacks.
 */
export const CLOSE_SERVICE_RESTART = 1012;

/**
 * What a client should do after the server closed its socket:
 *
 * - `"retry"` — transient (network, 1011 access-check or load failure, 1012
 *   restart, 1013, a dropped room or stalled send buffer). Back off, reconnect.
 * - `"reauth"` — 1008: the credentials were rejected, or an older server's
 *   ambiguous "Forbidden". Refresh the token and retry a bounded number of
 *   times (`MAX_REAUTH_ATTEMPTS`), then give up.
 * - `"terminal"` — the answer will not change: 4400–4499, i.e.
 *   `CLOSE_ACCESS_DENIED` (revoked), `CLOSE_FORBIDDEN`, `CLOSE_FLOW_GONE`.
 */
export type CloseVerdict = "retry" | "reauth" | "terminal";

export const MAX_REAUTH_ATTEMPTS = 3;

export function classifyClose(code: number): CloseVerdict {
  if (code >= 4400 && code < 4500) return "terminal";
  if (code === CLOSE_POLICY_VIOLATION) return "reauth";
  return "retry";
}
