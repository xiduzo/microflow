import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import { wireApp } from "./app-wiring";
import { routeTree } from "./routeTree.gen";
import { queryClient, trpc } from "@/lib/trpc";
import { loadAnalytics } from "@/lib/analytics";
import { LoadingState } from "@/ui/states/loading-state";
import { installGlobalErrorHandlers, reportError } from "@/lib/report-error";
import {
  AppErrorBoundary,
  NotFoundComponent,
  RouteErrorComponent,
} from "@/shell/failure-screens";

// Before anything can make a session.
wireApp();

loadAnalytics();
// As early as possible: anything thrown from here on is reported. Before the
// router exists the route lookup throws, which the handler treats as unknown.
installGlobalErrorHandlers(window, { route: currentRouteId });

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: () => <LoadingState />,
  defaultErrorComponent: RouteErrorComponent,
  defaultNotFoundComponent: NotFoundComponent,
  defaultOnCatch: (error) => reportError(error, { source: "route-boundary", route: currentRouteId() }),
  context: { trpc, queryClient },
  Wrap: function WrapComponent({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** The deepest matched route's id pattern (`/flow/$flowId`): never a concrete path with ids in it. */
function currentRouteId(): string | undefined {
  return router.state.matches.at(-1)?.routeId;
}

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>,
  );
}
