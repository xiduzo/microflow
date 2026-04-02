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
import { HotkeysProvider } from "react-hotkeys-hook";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { useBoardEvents } from "@/stores/board";
import { useComponentEvents } from "@/hooks/use-component-events";
import { useMqttSync } from "@/hooks/use-mqtt-sync";
import { useLlmSync } from "@/hooks/use-llm-sync";
import { useUpdater } from "@/hooks/use-updater";
import { useFigmaUniqueId, useFigmaStore } from "@/stores/figma";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

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
  return (
    <>
      <HeadContent />
      <Board />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        storageKey="microflow-ui-theme"
      >
        <SidebarProvider>
          <HotkeysProvider initiallyActiveScopes={["flow", "navigation"]}>
            <AppSidebar />
            <SidebarInset>
              <TooltipProvider>
                <div className="h-full w-full absolute inset-0">
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
    </>
  );
}

function Board() {
  useBoardEvents();
  useComponentEvents();
  useMqttSync();
  useLlmSync();
  useUpdater();

  // Keep the figma store's uniqueId in sync with the auth session
  const uniqueId = useFigmaUniqueId();
  useEffect(() => {
    useFigmaStore.getState().setUniqueId(uniqueId);
  }, [uniqueId]);

  return null;
}
