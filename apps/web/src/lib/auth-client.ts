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

/**
 * getSession that never throws on network failure. When no server is reachable
 * (offline / no server found) better-auth's fetch rejects with a raw TypeError;
 * treat that as "no session" so route beforeLoads fall through to local/login
 * instead of crashing the whole app with an unhandled route error.
 */
export async function getSession() {
  try {
    return await authClient.getSession();
  } catch {
    return { data: null, error: null };
  }
}

/** customer.state that resolves to null when the server is unreachable. */
export async function getCustomerState() {
  try {
    return await authClient.customer.state();
  } catch {
    return { data: null };
  }
}
