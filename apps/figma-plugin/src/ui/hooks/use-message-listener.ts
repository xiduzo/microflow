import { useCallback, useEffect, useRef } from "preact/hooks";
import {
  type MessageType,
  type PluginMessageEvent,
  sendToPlugin,
} from "../../common/messages";

interface MessageListenerOptions {
  /** Poll the plugin at this interval (ms). Omit to only listen passively. */
  intervalMs?: number;
  /** Send the request message immediately on mount. */
  sendInitial?: boolean;
}

/**
 * Listens for messages from the plugin sandbox and calls the callback
 * when the message type matches. Optionally polls at an interval.
 *
 * The callback is stored in a ref so it's always fresh without
 * re-registering the event listener.
 */
export function useMessageListener<T = undefined>(
  type: MessageType,
  callback: (payload: T | undefined) => void,
  options?: MessageListenerOptions,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const sendMessage = useCallback(
    (payload?: unknown) => {
      sendToPlugin({ type, payload } as any);
    },
    [type],
  );

  // Listen for responses from plugin
  useEffect(() => {
    function handler(event: PluginMessageEvent) {
      if (event.data.pluginMessage?.type !== type) return;
      callbackRef.current(event.data.pluginMessage.payload as T);
    }
    window.addEventListener("message", handler as EventListener);
    return () => window.removeEventListener("message", handler as EventListener);
  }, [type]);

  // Initial request on mount
  useEffect(() => {
    if (options?.sendInitial) sendMessage();
  }, [options?.sendInitial, sendMessage]);

  // Polling interval
  useEffect(() => {
    if (!options?.intervalMs) return;
    const id = setInterval(() => sendMessage(), options.intervalMs);
    return () => clearInterval(id);
  }, [options?.intervalMs, sendMessage]);

  return sendMessage;
}
