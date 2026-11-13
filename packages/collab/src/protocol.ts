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
 * The close code the server's auth gate uses today (`apps/server`): RFC 6455
 * "policy violation", sent for both an invalid session and a user who may not
 * open this flow. Outside y-websocket's 4400–4499 terminal range, so by default
 * the provider retries it forever — `isTerminalClose` adds it.
 */
export const CLOSE_POLICY_VIOLATION = 1008;

/**
 * Whether reconnecting after this close code can help. 4400–4499 is
 * y-websocket's convention (`CLOSE_ACCESS_DENIED`); 1008 is what the server's
 * auth gate sends. Both mean the answer will not change by asking again with
 * the same credentials.
 */
export function isTerminalClose(code: number): boolean {
  return code === CLOSE_POLICY_VIOLATION || (code >= 4400 && code < 4500);
}
