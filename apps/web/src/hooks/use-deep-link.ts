import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { isDesktop } from "@/lib/platform";

/**
 * Handles `microflow://flow/<flowId>` deep links (from shared web links opened
 * in the desktop app). Reads the cold-start URL and listens for runtime ones,
 * then routes to the flow. The `/flow/$flowId` route handles auth/redirect.
 * No-op in the browser.
 */
export function useDeepLink() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isDesktop()) return;

    const openFlow = (urls: string[] | null) => {
      for (const raw of urls ?? []) {
        try {
          const url = new URL(raw);
          if (url.hostname !== "flow") continue;
          const flowId = url.pathname.replace(/^\/+/, "");
          if (!flowId) continue;
          navigate({ to: "/flow/$flowId", params: { flowId } });
          return;
        } catch {
          // ignore malformed deep-link URLs
        }
      }
    };

    let unlisten: (() => void) | undefined;
    // Dynamic import: the plugin only exists in the desktop bundle.
    import("@tauri-apps/plugin-deep-link")
      .then(async ({ getCurrent, onOpenUrl }) => {
        openFlow(await getCurrent());
        unlisten = await onOpenUrl(openFlow);
      })
      .catch(() => {});

    return () => unlisten?.();
  }, [navigate]);
}
