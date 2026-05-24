import { useEffect, useMemo } from "react";
import { acquireCloudSession, releaseSession } from "./session-registry";
import type { FlowSession } from "./flow-session";
import type { CreateCloudSessionOptions } from "./flow-session";

export function useCloudSession(options: CreateCloudSessionOptions): FlowSession {
  const session = useMemo(
    () => acquireCloudSession(options),
    // Identity keyed on flowId; sync adapter is constructed once per acquire.
    // Changes to user / authToken require a reconnect handled inside the adapter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.flowId],
  );
  useEffect(() => {
    return () => releaseSession(session.flowId);
  }, [session.flowId]);
  return session;
}
