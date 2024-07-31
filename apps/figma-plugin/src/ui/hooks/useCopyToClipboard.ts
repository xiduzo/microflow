import { useEffect, useState } from "react";
import { ShowToast } from "../../common/types/Message";
import { sendMessageToFigma } from "../utils/sendMessageToFigma";

export function useCopyToClipboard() {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  function copyFunction(valueToCopy: string) {
    if ("clipboard" in navigator) {
      return navigator.clipboard
        .writeText(valueToCopy)
        .then(() => {
          setCopiedValue(valueToCopy);
        })
        .catch(console.error);
    }

    if ("copy" in window) {
      // @ts-expect-error ignore TS error
      void window.copy(valueToCopy);
      setCopiedValue(valueToCopy);
      return;
    }

    // This is very hacky, but it works
    // Sue me
    const area = document.createElement("textarea");
    document.body.appendChild(area);
    area.value = valueToCopy;
    area.focus();
    area.select();
    const success = document.execCommand("copy");
    document.body.removeChild(area);
    if (success) {
      setCopiedValue(valueToCopy);
      return;
    }

    sendMessageToFigma(
      ShowToast("Unabled to copy to clipboard", { error: true }),
    );
  }

  useEffect(() => {
    if (!copiedValue) return;

    sendMessageToFigma(
      ShowToast("Copied to clipboard!", { timeout: 500 }),
    );

    const timeout = setTimeout(() => {
      setCopiedValue(null);
    }, 500);

    return () => {
      clearTimeout(timeout);
    };
  }, [copiedValue]);

  return [copiedValue, copyFunction] as const;
}
