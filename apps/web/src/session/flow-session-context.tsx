import {
  createContext,
  Fragment,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { withLiveAccess, type FlowSession } from "./flow-session";

export const FlowSessionContext = createContext<FlowSession | null>(null);

/**
 * Provides the session as the editor should see it: when the room changes the
 * local user's access mid-session (demotion, promotion, access lost), the
 * context value becomes `withLiveAccess(session, …)`, so every consumer that
 * reads `readOnly`/`doc` from `useFlowSession()` follows without knowing why.
 */
export function FlowSessionProvider({
  session,
  children,
}: {
  session: FlowSession;
  children: ReactNode;
}) {
  const { readOnly } = useSyncExternalStore(session.status.subscribe, session.status.getSnapshot);
  const live = useMemo(() => withLiveAccess(session, readOnly), [session, readOnly]);
  return <FlowSessionContext.Provider value={live}>{children}</FlowSessionContext.Provider>;
}

/**
 * Remount `children` when the session's write access changes.
 *
 * Some consumers capture `readOnly` once at construction — `ReactFlowBridge`
 * via `useReactFlowBridge`'s lazy state — so an access change must give them
 * a fresh mount. Wrap the editing surface, not the whole provider subtree:
 * the runtime dispatcher only reads the doc and should not restart.
 */
export function RemountOnAccessChange({ children }: { children: ReactNode }) {
  const session = useContext(FlowSessionContext);
  return <Fragment key={session?.readOnly ? "read" : "write"}>{children}</Fragment>;
}
