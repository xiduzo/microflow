import { useEffect } from "preact/hooks";
import { messages, sendToPlugin } from "../../common/messages";

export function useWindowSize(opts: { width: number; height: number }) {
  useEffect(() => {
    sendToPlugin(messages.setUiOptions(opts));
  }, [opts.width, opts.height]);
}
