import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_SERVER_URL: z.url(),
    // Public web app origin, used for share links from the desktop build
    // (where window.location.origin is tauri://localhost). Optional; falls
    // back to window.location.origin in the browser.
    VITE_WEB_URL: z.url().optional(),
  },
  runtimeEnv: (import.meta as any).env,
  emptyStringAsUndefined: true,
});
