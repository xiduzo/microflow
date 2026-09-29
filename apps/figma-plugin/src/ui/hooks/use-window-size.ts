import { messages } from "@microflow/design-bridge";
import { useEffect } from "preact/hooks";
import { channel } from "../channel";

export function useWindowSize(size: { width: number; height: number }) {
  useEffect(() => {
    channel.send(messages.resize(size.width, size.height));
  }, [size.width, size.height]);
}
