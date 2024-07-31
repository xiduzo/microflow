import { useCallback, useEffect, useRef, useState } from "react";

import {
  GetLocalStateValue,
  LOCAL_STORAGE_KEYS,
  MESSAGE_TYPE,
  SetLocalStateValue,
} from "../../common/types/Message";
import { sendMessageToFigma } from "../utils/sendMessageToFigma";
import { useMessageListener } from "./useMessageListener";

type Update<T> = T | ((prev?: T) => T | undefined);

export function useLocalStorage<T>(
  key: LOCAL_STORAGE_KEYS,
  options: { initialValue?: T; updateInterval?: number } = {}
) {
  const [state, setState] = useState(options.initialValue);
  const localStatePromise = useRef<
    [
      ((value?: unknown) => void) | undefined,
      ((reason?: unknown) => void) | undefined
    ]
  >([undefined, undefined]);

  const setLocalState = useCallback(
    (update?: Update<T>) => {
      const [, reject] = localStatePromise.current;
      reject?.("Cancelled");

      return new Promise((resolve, reject) => {
        localStatePromise.current = [resolve, reject];
        sendMessageToFigma(
          SetLocalStateValue(
            key,
            update instanceof Function ? update(state) : update
          )
        );
        setTimeout(() => {
          reject("Timeout");
        }, 1000);
      });
    },
    [key, state]
  );

  useEffect(() => {
    sendMessageToFigma(GetLocalStateValue(key, options?.initialValue));
  }, [key, options?.initialValue]);

  useMessageListener<{ key: LOCAL_STORAGE_KEYS; value?: T }>(
    MESSAGE_TYPE.GET_LOCAL_STATE_VALUE,
    (payload) => {
      if (payload?.key !== key) return;

      setState(payload.value);
    },
    { intervalInMs: options?.updateInterval }
  );

  useMessageListener<{ key: LOCAL_STORAGE_KEYS; value?: T }>(
    MESSAGE_TYPE.SET_LOCAL_STATE_VALUE,
    (payload) => {
      if (payload?.key !== key) return;
      const [resolve] = localStatePromise.current;
      resolve?.();

      setState(payload?.value);
    }
  );
  return [
    state as typeof options.initialValue extends undefined ? T | undefined : T,
    setLocalState,
  ] as const;
}
