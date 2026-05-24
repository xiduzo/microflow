import { authClient } from "@/lib/auth-client";
import { useAppStore } from "@/stores/app";
import { useCircuitStore } from "@/stores/circuit-store";
import {
  FlowSessionProvider,
  useCloudSession,
  useFlowSession,
  useFlowUpdateDispatcher,
  useFlowNodes,
  useLocalSession,
  type FlowSession,
} from "@/session";
import { usePins, type Pin } from "@/stores/board";
import { useComponentEvents } from "@/hooks/use-component-events";
import { useHotkeyEvents } from "@/hooks/use-hotkey-events";
import { useDebouncer } from "@tanstack/react-pacer";
import { trpc } from "@/lib/trpc";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { env } from "@microflow/env/web";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { isDesktop } from "@/lib/platform";
import type { Node } from "@xyflow/react";

/**
 * Inside-provider listeners — events that need access to the session's
 * FlowDocument (component events, hotkey events, optional desktop dispatch).
 * Returns null; effects only.
 */
function FlowEventListeners() {
  const session = useFlowSession();
  useComponentEvents();
  useHotkeyEvents();
  if (isDesktop()) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useFlowUpdateDispatcher(session);
  }
  return null;
}

/**
 * Listens to session doc nodes and board pins; triggers circuit build in the
 * circuit store. Mounted under /flow/$flowId so the circuit is built in the
 * background before the user opens the circuit tab.
 */
function CircuitBuildListener() {
  const { doc } = useFlowSession();
  const nodes = useFlowNodes(doc);
  const pins = usePins();
  const buildCircuit = useCircuitStore((s) => s.buildCircuit);

  const debouncer = useDebouncer(
    (nodes: Node[], pins: Pin[]) => {
      buildCircuit(nodes, pins);
    },
    { wait: 1000 },
  );

  useEffect(() => {
    debouncer.maybeExecute(nodes, pins);
  }, [nodes, pins, debouncer.maybeExecute]);

  return null;
}

export const Route = createFileRoute("/flow/$flowId")({
  component: RouteComponent,
  beforeLoad: async ({ params }) => {
    const session = await authClient.getSession();

    if (params.flowId === "local") {
      const { data: customerState } = await authClient.customer.state();
      return { session, customerState };
    }

    if (!session.data) {
      throw redirect({
        to: "/login",
        search: { redirect: `/flow/${params.flowId}` },
      });
    }

    const { data: customerState } = await authClient.customer.state();
    return { session, customerState };
  },
});

function RouteComponent() {
  const { flowId } = Route.useParams();
  return flowId === "local" ? <LocalFlowLayout /> : <CloudFlowLayout />;
}

function FlowProviderShell({ session }: { session: FlowSession }) {
  return (
    <FlowSessionProvider session={session}>
      <FlowEventListeners />
      <CircuitBuildListener />
      <Outlet />
    </FlowSessionProvider>
  );
}

function LocalFlowLayout() {
  const setActiveFlowId = useAppStore((s) => s.setActiveFlowId);
  const session = useLocalSession();

  useEffect(() => {
    setActiveFlowId("local");
  }, [setActiveFlowId]);

  return <FlowProviderShell session={session} />;
}

function CloudFlowLayout() {
  const { flowId } = Route.useParams();
  const { session: authSession } = Route.useRouteContext();
  const setActiveFlowId = useAppStore((s) => s.setActiveFlowId);

  const wsUrl = useMemo(() => {
    const serverUrl = new URL(env.VITE_SERVER_URL);
    serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
    return serverUrl.origin;
  }, []);

  const { data: flow, isLoading, error } = useQuery({
    ...trpc.flow.get.queryOptions({ id: flowId }),
    enabled: flowId !== "local",
  });

  useEffect(() => {
    setActiveFlowId(flowId);
    return () => {
      useCircuitStore.getState().reset();
    };
  }, [flowId, setActiveFlowId]);

  const { data: profile } = useQuery({
    ...trpc.profile.get.queryOptions(),
    enabled: !!authSession.data,
  });

  const { data: supporterStatus } = useQuery({
    ...trpc.supporters.myStatus.queryOptions(),
    enabled: !!authSession.data,
    staleTime: 5 * 60 * 1000,
  });
  const isSupporter = supporterStatus?.isSupporter ?? false;

  const user = useMemo(
    () => ({
      id: authSession.data!.user.id,
      name: authSession.data!.user.name ?? "Anonymous",
      color: profile?.settings.collabColor,
      icon: profile?.settings.collabIcon,
      isSupporter,
    }),
    [
      authSession.data?.user.id,
      authSession.data?.user.name,
      profile?.settings.collabColor,
      profile?.settings.collabIcon,
      isSupporter,
    ],
  );

  const authToken = isDesktop() ? (localStorage.getItem("bearer_token") ?? undefined) : undefined;

  const initialData = useMemo(() => {
    if (!flow?.ydocBase64) return undefined;
    return Uint8Array.from(atob(flow.ydocBase64), (c) => c.charCodeAt(0));
  }, [flow?.ydocBase64]);

  if (isLoading || !flow) return <LoadingState />;
  if (error) return <ErrorState title="Failed to load flow" error={error} />;

  return (
    <CloudFlowSessionMount
      flowId={flowId}
      wsUrl={wsUrl}
      user={user}
      authToken={authToken}
      initialData={initialData}
      meta={{ name: flow.name }}
    />
  );
}

/**
 * Calling `useCloudSession` requires `flow` to be loaded — split into a
 * separate component so the hook never sees a half-set `user`/`initialData`.
 */
function CloudFlowSessionMount(props: {
  flowId: string;
  wsUrl: string;
  user: { id: string; name: string; color?: string; icon?: string; isSupporter?: boolean };
  authToken?: string;
  initialData?: Uint8Array;
  meta?: { name?: string; description?: string };
}) {
  const session = useCloudSession(props);
  return <FlowProviderShell session={session} />;
}
