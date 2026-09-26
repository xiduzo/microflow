import type { QueryClient } from "@tanstack/react-query";

import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";

import type { trpc } from "@/lib/trpc";

import { ThemeProvider } from "@/ui/theme-provider";
import { Toaster } from "@/ui/sonner";
import { SetNameDialog } from "@/account/set-name-dialog";

import "@/index.css";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { TooltipProvider } from "@/ui/tooltip";
import { SidebarInset, SidebarProvider } from "@/ui/sidebar";
import { AppSidebar } from "@/shell/app-sidebar";
import { useBoardEvents } from "@/board/board-store";
import { useCloudCapabilitySync } from "@/cloud/cloud-capabilities";
import { useUpdater } from "@/platform/use-updater";
import { useDeepLink } from "@/platform/use-deep-link";
import { useDesignBridgeAccount } from "@/cloud/design-bridge-account";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { MicroflowDevtools } from "@/devtools/microflow-devtools";
import { useBackendLogs } from "@/devtools/use-backend-logs";
import ReactConfetti from "react-confetti";
import { useFirstArduinoConnection } from "@/board/use-first-arduino-connection";
import { useSidebarStore } from "@/shell/sidebar";

export interface RouterAppContext {
  trpc: typeof trpc;
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "microflow",
      },
      {
        name: "description",
        content: "microflow is a a visual, flow-based programming tool for hardware prototyping and IoT",
      },
    ],
    links: [
      {
        rel: "icon",
        href: "/favicon.ico",
      },
    ],
  }),
});

function RootComponent() {
  const showConfetti = useFirstArduinoConnection();
  const sidebarOpen = useSidebarStore((s) => s.sidebarOpen);
  const setSidebarOpen = useSidebarStore((s) => s.setSidebarOpen);

  return (
    <>
      <HeadContent />
      <Board />
      {showConfetti && (
        <ReactConfetti
          style={{ position: "fixed", inset: 0, zIndex: 9999, pointerEvents: "none" }}
          width={window.innerWidth}
          height={window.innerHeight}
          recycle={false}
          numberOfPieces={500}
        />
      )}
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        storageKey="microflow-ui-theme"
      >
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <HotkeysProvider>
            <AppSidebar />
            <SidebarInset>
              <TooltipProvider>
                <div className="h-full w-full absolute inset-0 overflow-y-auto rounded-3xl">
                  <Outlet />
                </div>
              </TooltipProvider>
            </SidebarInset>
          </HotkeysProvider>
        </SidebarProvider>
        <Toaster richColors position="top-right" />
        <SetNameDialog />
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-right" />
      <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
      <MicroflowDevtools />
    </>
  );
}

function Board() {
  useBoardEvents();
  useCloudCapabilitySync();
  useUpdater();
  useBackendLogs();
  useDeepLink();

  useDesignBridgeAccount();

  return null;
}
