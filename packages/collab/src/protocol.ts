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
