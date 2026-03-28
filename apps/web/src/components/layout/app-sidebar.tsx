import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookIcon,
  CircuitBoardIcon,
  LibraryBigIcon,
  BotIcon,
  RadioTowerIcon,
  SettingsIcon,
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
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useMemo } from "react";
import { isDesktop } from "@/lib/platform";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const activeFlowId = useActiveFlowStore((s) => s.activeFlowId);

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
            activeFlowDescription={activeFlow.id !== "local" ? "Stored in the cloud" : "Stored on this device"}
          />
        </SidebarHeader>
        <SidebarContent>
          <NavMicrocontroller />
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
                  // {
                  //   title: "Community",
                  //   url: "/community",
                  //   icon: BookSearchIcon,
                  // },
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
              ...(isDesktop()
                ? [
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
                ]
                : [])
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