import { createContext, type ReactNode } from "react";
import type { FlowSession } from "./flow-session";

export const FlowSessionContext = createContext<FlowSession | null>(null);

export function FlowSessionProvider({
  session,
  children,
}: {
  session: FlowSession;
  children: ReactNode;
}) {
  return <FlowSessionContext.Provider value={session}>{children}</FlowSessionContext.Provider>;
}
