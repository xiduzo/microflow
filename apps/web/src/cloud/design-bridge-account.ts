import { useEffect } from "react";
import { authClient } from "@/account/auth-client";
import { useDesignBridgeStore } from "./design-bridge";

/** Keep the design-bridge store's account name in step with the auth session,
 *  so the default Bridge ID follows the signed-in account. */
export function useDesignBridgeAccount(): void {
  const { data: session } = authClient.useSession();
  const name = session?.user?.name ?? null;
  useEffect(() => {
    useDesignBridgeStore.getState().setAccountName(name);
  }, [name]);
}
