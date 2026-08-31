import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookIcon,
  CircuitBoardIcon,
  CodeIcon,
  EarthIcon,
  LibraryBigIcon,
  BotIcon,
  BotMessageSquareIcon,
  RadioTowerIcon,
  WaypointsIcon,
} from "lucide-react";

import { NavMain } from "@/components/layout/nav-main";
import { NavSecondary } from "@/components/layout/nav-secondary";
import { NavUser } from "@/components/layout/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import { FlowSwitcher, LOCAL_FLOW } from "./flow-switcher";
import { NavMicrocontroller } from "./nav-microcontroller";
import { NavDownloadStudio } from "./nav-download-studio";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { useAppStore } from "@/stores/app";
import { useAskAiStore } from "@/stores/ask-ai";
import { useMemo } from "react";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const activeFlowId = useAppStore((s) => s.activeFlowId);
  const askAiOpen = useAskAiStore((s) => s.open);
  const toggleAskAi = useAskAiStore((s) => s.toggle);

  const { data: cloudFlows } = useQuery({
    ...trpc.flow.list.queryOptions(),
    enabled: !!user,
  });

  const flows = useMemo(() => {
    const allFlows = [LOCAL_FLOW];

    if (cloudFlows) {
      allFlows.push(...cloudFlows.owned, ...cloudFlows.collaborated);
    }

    return allFlows;
  }, [cloudFlows]);

  const activeFlow = useMemo(() => {
    return flows.find((f) => f.id === activeFlowId) ?? LOCAL_FLOW;
  }, [flows, activeFlowId]);

  return (
    <>
      <Sidebar collapsible="icon" variant="inset" {...props}>
        <SidebarHeader>
          <FlowSwitcher
            flows={flows}
            user={user}
            activeFlowDescription={
              activeFlow.id !== "local"
                ? "Stored in the cloud"
                : "Stored on this device"
            }
          />
        </SidebarHeader>
        <SidebarContent>
          <NavMicrocontroller />
          <NavDownloadStudio />
          <NavMain
            groups={[
              {
                title: activeFlow.name,
                routes: [
                  {
                    title: "Edit flow",
                    icon: WaypointsIcon,
                    url: `/flow/${activeFlow.id}/graph`,
                  },
                  {
                    title: "Show circuit",
                    icon: CircuitBoardIcon,
                    url: `/flow/${activeFlow.id}/circuit`,
                  },
                  {
                    title: "Show code",
                    icon: CodeIcon,
                    url: `/flow/${activeFlow.id}/code`,
                    badge: "beta",
                  },
                  // Toggles the side panel rather than navigating: the assistant
                  // edits the canvas, so it has to sit beside it.
                  {
                    title: "Ask AI",
                    icon: BotMessageSquareIcon,
                    onClick: toggleAskAi,
                    isActive: askAiOpen,
                    badge: "beta",
                  },
                ],
              },
              {
                title: "General",
                routes: [
                  {
                    title: "My flows",
                    url: "/",
                    icon: BookIcon,
                  },
                  {
                    title: "Community",
                    url: "/community",
                    icon: EarthIcon,
                  },
                  {
                    title: "Templates",
                    url: "/templates",
                    icon: LibraryBigIcon,
                  },
                  // {
                  //   title: "Learning",
                  //   url: "/learning",
                  //   icon: GraduationCapIcon,
                  // },
                ],
              },
              // Shown in both hosts: the browser runs the Mqtt/Figma/Llm nodes
              // itself (ADR-0009) and reads these stores, so hiding the pages on
              // web left those nodes unconfigurable there.
              {
                title: "Configuration",
                routes: [
                  {
                    title: "MQTT",
                    url: "/configuration/mqtt",
                    icon: RadioTowerIcon,
                  },
                  {
                    title: "LLM",
                    url: "/configuration/llm",
                    icon: BotIcon,
                  },
                ],
              },
            ]}
          />
          <NavSecondary className="mt-auto" />
        </SidebarContent>
        <SidebarFooter>
          <NavUser user={user} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    </>
  );
}
