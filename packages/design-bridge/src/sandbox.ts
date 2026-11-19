/**
 * The sandbox side of a plugin: the code with access to the design file. Each
 * design tool implements one `SandboxAdapter`; the routing between the adapter
 * and the UI iframe's messages is the same for every tool and lives here.
 */
import type { BridgeSnapshotEntry } from "./bridge";
import type { BridgeValue } from "./protocol";
import {
  MSG,
  type MessageHandlers,
  type MessageType,
  type PluginMessage,
  createMessageRouter,
  messages,
} from "./rpc";

/** A design tool's bridge variables: Figma's `MHB` collection, Penpot's `MHB` token set. */
export interface SandboxAdapter {
  /** The bridge variables with their current values. Variables the bridge cannot carry are left out. */
  readSnapshot(): BridgeSnapshotEntry[] | Promise<BridgeSnapshotEntry[]>;
  /**
   * Write one value. `id` is the tool's own variable ID, as the snapshot gave it.
   * Returns `null` when there is nothing to tell the user, and a rejection
   * when the tool did not take the value.
   */
  writeValue(id: string, value: BridgeValue): WriteResult | Promise<WriteResult>;
}

/** A write the design tool did not take. The message is shown to the user. */
export type WriteRejection = { message: string; cause?: unknown };
export type WriteResult = WriteRejection | null;

/** What the routing needs from the plugin's host glue. */
export type SandboxHost = {
  /** Deliver a message to the UI iframe. */
  send(message: PluginMessage): void;
  /** Tell the user about a rejected write. */
  reportError(text: string, cause?: unknown): void;
  /** A handler failed for another reason. The default logs it. */
  onFailure?(type: MessageType, error: unknown): void;
};

/**
 * Route the UI's messages: the hello, snapshot requests and writes go to the
 * adapter; `glue` handles what only this tool's host can do (storage, toasts,
 * links, resizing). A `glue` handler for the hello runs after the reply.
 */
export function createSandboxBridge(
  adapter: SandboxAdapter,
  host: SandboxHost,
  glue: MessageHandlers = {},
) {
  const dispatch = createMessageRouter(
    {
      ...glue,
      [MSG.UI_READY]: (payload) => {
        host.send(messages.uiReady());
        return glue[MSG.UI_READY]?.(payload);
      },
      [MSG.GET_VARIABLES]: () =>
        settle(adapter.readSnapshot(), (entries) => host.send(messages.getVariables(entries))),
      [MSG.SET_VARIABLE]: ({ id, value }) =>
        settle(adapter.writeValue(id, value), (rejection) => {
          if (rejection) host.reportError(rejection.message, rejection.cause);
        }),
    },
    host.onFailure,
  );

  return {
    /** Handle one message from the UI iframe. Anything that is not a plugin message is ignored. */
    dispatch,
    /** Send the UI a snapshot it did not ask for, after the design file changed. */
    pushSnapshot: () => dispatch(messages.getVariables()),
  };
}

/** Continue at once for an adapter that answers synchronously, and later for one that does not. */
function settle<T>(value: T | Promise<T>, next: (value: T) => void): void | Promise<void> {
  return value instanceof Promise ? value.then(next) : next(value);
}
