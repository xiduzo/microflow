import type { QueryClient } from "@tanstack/react-query";

import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import type { trpc } from "@/utils/trpc";

import { ThemeProvider } from "@/providers/theme-provider";
import { Toaster } from "@/components/ui/sonner";

import "../index.css";
import { HotkeysProvider } from "react-hotkeys-hook";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBoardEvents } from "@/stores/board";
import { useComponentEvents } from "@/hooks/use-component-events";

export interface RouterAppContext {
  trpc: typeof trpc;
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "microflow-t-stack",
      },
      {
        name: "description",
        content: "microflow-t-stack is a web application",
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
          <AppSidebar />
          <SidebarInset>
            <HotkeysProvider initiallyActiveScopes={["flow"]}>
              {/* <header className="backdrop-blur-sm bg-muted-foreground/2 m-4 rounded-xl p-2 px-4 flex justify-between items-center absolute top-0 left-0 right-0 z-50">
                <SidebarTrigger className="-ml-1" />
                <Tabs defaultValue="flow">
                  <TabsList>
                    <TabsTrigger value="flow">Flow</TabsTrigger>
                    <TabsTrigger value="circuit">Circuit</TabsTrigger>
                  </TabsList>
                </Tabs>
              </header> */}
              <TooltipProvider>
                <div className="h-full w-full absolute inset-0">
                <Outlet />
                </div>
              </TooltipProvider>
            </HotkeysProvider>
          </SidebarInset>
        </SidebarProvider>
        <Toaster richColors position="top-right" />
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-right" />
      <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
    </>
  );
}

function Board() {
  useBoardEvents();
  useComponentEvents();
  return null;
}
