import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";

import type { trpc } from "@/lib/trpc";

import { ThemeProvider } from "@/providers/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { SetNameDialog } from "@/components/set-name-dialog";

import "../index.css";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { useBoardEvents } from "@/stores/board";
import { useMqttSync } from "@/hooks/use-mqtt-sync";
import { useLlmSync } from "@/hooks/use-llm-sync";
import { useUpdater } from "@/hooks/use-updater";
import { useFigmaUniqueId, useFigmaStore } from "@/stores/figma";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { MicroflowDevtools } from "@/components/devtools/microflow-devtools";
import { useBackendLogs } from "@/hooks/use-backend-logs";
import ReactConfetti from "react-confetti";
import { useFirstArduinoConnection } from "@/hooks/use-first-arduino-connection";
import { useAppStore } from "@/stores/app";

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
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

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
  useMqttSync();
  useLlmSync();
  useUpdater();
  useBackendLogs();

  // Keep the figma store's uniqueId in sync with the auth session
  const uniqueId = useFigmaUniqueId();
  useEffect(() => {
    useFigmaStore.getState().setUniqueId(uniqueId);
  }, [uniqueId]);

  return null;
}
