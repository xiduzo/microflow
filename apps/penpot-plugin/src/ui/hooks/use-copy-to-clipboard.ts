import { useEffect, useState } from "react";
import { messages, sendToPlugin } from "../../common/messages";

export function useCopyToClipboard() {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  function copy(value: string) {
    if ("clipboard" in navigator) {
      navigator.clipboard
        .writeText(value)
        .then(() => setCopiedValue(value))
        .catch(console.error);
      return;
    }

    // Fallback: textarea trick
    const area = document.createElement("textarea");
    document.body.appendChild(area);
    area.value = value;
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    if (ok) {
      setCopiedValue(value);
    } else {
      sendToPlugin(messages.showToast("Unable to copy to clipboard"));
    }
  }

  useEffect(() => {
    if (!copiedValue) return;
    sendToPlugin(messages.showToast("Copied to clipboard!"));
    const t = setTimeout(() => setCopiedValue(null), 2000);
    return () => clearTimeout(t);
  }, [copiedValue]);

  return [copiedValue, copy] as const;
}
