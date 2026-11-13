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
 * The close code the server's auth gate uses (`apps/server`): RFC 6455
 * "policy violation". The reason tells the two cases apart — "Unauthorized"
 * (no valid session) and "Forbidden" (this user may not open this flow).
 * Outside y-websocket's 4400–4499 terminal range, so by default the provider
 * retries both forever — `classifyClose` decides instead.
 */
export const CLOSE_POLICY_VIOLATION = 1008;
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
 * - `"retry"` — transient (network, 1011 load failure, 1012 restart, 1013,
 *   a dropped room or stalled send buffer). Back off and reconnect.
 * - `"reauth"` — the credentials were rejected (1008 "Unauthorized"). A token
 *   refreshed in the meantime may fix it, so retry with a freshly read token —
 *   a bounded number of times (`MAX_REAUTH_ATTEMPTS`), then give up.
 * - `"terminal"` — the answer will not change (1008 "Forbidden", 4400–4499
 *   including `CLOSE_ACCESS_DENIED` "Access revoked"). Stop.
 */
export type CloseVerdict = "retry" | "reauth" | "terminal";

export const MAX_REAUTH_ATTEMPTS = 3;

export function classifyClose(code: number, reason = ""): CloseVerdict {
  if (code >= 4400 && code < 4500) return "terminal";
  if (code === CLOSE_POLICY_VIOLATION) {
    return /unauthori[sz]ed/i.test(reason) ? "reauth" : "terminal";
  }
  return "retry";
}
