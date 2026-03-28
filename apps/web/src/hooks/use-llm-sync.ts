import { useEffect } from "react";
import { useLlmProviderStore } from "@/stores/llm-provider";
import { invokeCommand } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";

export function useLlmSync() {
  const providers = useLlmProviderStore((s) => s.providers);
  const setStatus = useLlmProviderStore((s) => s.setStatus);

  useEffect(() => {
    if (!isDesktop()) return;

    invokeCommand({
      type: "llm_sync_providers",
      providers: providers.map((p) => ({ id: p.id, name: p.name, base_url: p.baseUrl, api_key: p.apiKey })),
    });

    for (const p of providers) {
      setStatus(p.id, "testing");
      invokeCommand({ type: "llm_test_provider", baseUrl: p.baseUrl, apiKey: p.apiKey })
        .then((result) => setStatus(p.id, result.success ? "ok" : "error"));
    }
  }, [providers, setStatus]);
}

export function useProviderStatus(providerId: string) {
  return useLlmProviderStore((s) => s.statuses[providerId] ?? "idle");
}
