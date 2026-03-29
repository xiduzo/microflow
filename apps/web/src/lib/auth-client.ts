import { env } from "@microflow/env/web";
import { polarClient } from "@polar-sh/better-auth";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { isDesktop } from "./platform";

const AUTH_TOKEN_KEY = "bearer_token";

export const authClient = createAuthClient({
  baseURL: env.VITE_SERVER_URL,
  fetchOptions: {
    credentials: "include",
    auth: isDesktop()
      ? {
          type: "Bearer",
          token: () => localStorage.getItem(AUTH_TOKEN_KEY) || "",
        }
      : undefined,
    onSuccess: (ctx) => {
      if (isDesktop()) {
        const authToken = ctx.response.headers.get("set-auth-token");
        if (authToken) {
          localStorage.setItem(AUTH_TOKEN_KEY, authToken);
        }
      }
    },
  },
  plugins: [polarClient(), emailOTPClient()],
});
