import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { CompassIcon, HomeIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";

import { errorFingerprint, reportError, type ErrorSource } from "@/lib/report-error";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/states/empty-state";
import { ErrorState } from "@/ui/states/error-state";
import { cn } from "@/ui/utils";

/**
 * The screens a user sees when something throws: the app-wide boundary
 * (around the router), the route error component (one per route match), and
 * the not-found screen.
 *
 * None of them touch the flow document. A reload is safe for the local flow
 * because `IndexeddbSyncAdapter` writes every update as it happens; a cloud
 * flow lives on the server. Reporting happens where the error is caught
 * (`componentDidCatch`, the router's `defaultOnCatch`), not on render, so a
 * re-render of the fallback never reports twice.
 */

/** What the fallback shows: the message (local only, never sent) and the same reference the report carries. */
export function failureDetails(error: unknown, source: ErrorSource) {
  const message =
    error instanceof Error && error.message ? error.message : "An unexpected error occurred.";
  return { message, reference: errorFingerprint(error, source) };
}

type FailureViewProps = {
  error: unknown;
  source: ErrorSource;
  /** Re-render the failed part without a reload. Omitted when there is nothing to retry. */
  onRetry?: () => void;
  onBackToFlows: () => void;
  /** Fill the viewport: used when the app shell itself is gone. */
  fullscreen?: boolean;
};

function FailureView({ error, source, onRetry, onBackToFlows, fullscreen }: FailureViewProps) {
  const { message, reference } = failureDetails(error, source);
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  return (
    <div className={cn("h-full w-full", fullscreen && "fixed inset-0 bg-background")} role="alert">
      <ErrorState title="Something went wrong" error={{ message }}>
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry && (
            <Button variant="outline" onClick={onRetry}>
              <RotateCcwIcon data-icon="inline-start" />
              Try again
            </Button>
          )}
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RefreshCwIcon data-icon="inline-start" />
            Reload
          </Button>
          <Button onClick={onBackToFlows}>
            <HomeIcon data-icon="inline-start" />
            Back to flows
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Reloading does not delete your saved flows. Reference <code>{reference}</code>
        </p>
        {stack && (
          <details className="max-w-2xl text-left text-xs text-muted-foreground">
            <summary className="cursor-pointer">Stack trace (development only)</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap">{stack}</pre>
          </details>
        )}
      </ErrorState>
    </div>
  );
}

/** A full page load to the flow list: the one exit that works with no router or shell left. */
function hardNavigateToFlows() {
  window.location.assign("/");
}

/**
 * The route-level error screen (`defaultErrorComponent`). Rendered inside the
 * failed route's slot, so the sidebar and every other route keep working;
 * navigating away resets the boundary.
 */
export function RouteErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <FailureView
      error={error}
      source="route-boundary"
      onRetry={() => {
        // Re-run loaders as well as re-rendering, in case the loader threw.
        reset();
        void router.invalidate();
      }}
      onBackToFlows={() => {
        void router.navigate({ to: "/" });
      }}
    />
  );
}

/**
 * The root route's error screen. The root component is the app shell, so when
 * it throws there is no sidebar to render inside: take the whole viewport and
 * leave by a full page load.
 */
export function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  return (
    <FailureView
      error={error}
      source="route-boundary"
      fullscreen
      onRetry={reset}
      onBackToFlows={hardNavigateToFlows}
    />
  );
}

/** `defaultNotFoundComponent`: an unknown URL or a `notFound()` thrown by a loader. */
export function NotFoundComponent() {
  return (
    <EmptyState
      icon={CompassIcon}
      title="Page not found"
      description="This page does not exist, or it moved."
    >
      <Button render={<Link to="/" />}>
        <HomeIcon data-icon="inline-start" />
        Back to flows
      </Button>
    </EmptyState>
  );
}

type AppErrorBoundaryState = { error: unknown; failed: boolean };

/**
 * The outermost boundary, around the router and its providers. It catches
 * what the route boundaries cannot: a throw in the router itself, in `Wrap`
 * (the query client provider), or in a route error component.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    reportError(error, { source: "app-boundary" });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <FailureView
        error={this.state.error}
        source="app-boundary"
        fullscreen
        onBackToFlows={hardNavigateToFlows}
      />
    );
  }
}
