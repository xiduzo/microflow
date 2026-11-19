/**
 * The Connection Console sessions, as the configuration pages use them: one
 * session for as long as the page is mounted, live between mount and unmount,
 * and its state re-rendering the page whenever it changes.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { isDesktop } from "@/platform/platform";

import { createBrokerConsoleSession } from "./broker-console-session";
import { hostBrokerTransport } from "./broker-transport";
import type { ConsoleSession, ConsoleState } from "./console-session";
import { createLlmConsoleSession } from "./llm-console-session";

function useSession<Extra, Session extends ConsoleSession<Extra>>(
  create: () => Session & ConsoleSession<Extra>,
): [ConsoleState<Extra>, Session] {
  // Creating a session touches nothing outside it, so it is safe in a state
  // initialiser; the host work starts in the effect and ends with it.
  const [session] = useState(create);
  useEffect(() => session.open(), [session]);
  return [useSyncExternalStore(session.subscribe, session.getState), session];
}

/** The MQTT broker console, on this host's transport. */
export function useBrokerConsole() {
  return useSession(() => createBrokerConsoleSession({ transport: hostBrokerTransport() }));
}

/** The LLM provider console. */
export function useLlmConsole() {
  return useSession(() =>
    createLlmConsoleSession({ host: { desktop: isDesktop(), origin: window.location.origin } }),
  );
}
