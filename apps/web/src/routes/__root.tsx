import type { QueryClient } from "@tanstack/react-query";

import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import type { trpc } from "@/utils/trpc";

import Header from "@/components/header";
import { ThemeProvider } from "@/providers/theme-provider";
import { Toaster } from "@/components/ui/sonner";

import "../index.css";
import { HotkeysProvider } from "react-hotkeys-hook";
import { TooltipProvider } from "@/components/ui/tooltip";

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
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        storageKey="microflow-ui-theme"
      >
        <main className="w-screen h-screen">
          <HotkeysProvider initiallyActiveScopes={["flow"]}>
            <TooltipProvider>
              <Outlet />
            </TooltipProvider>
          </HotkeysProvider>
        </main>
        <Toaster richColors />
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-left" />
      <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
    </>
  );
}
