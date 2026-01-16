import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CircuitBoardIcon,
  HardDriveDownloadIcon,
  HardDriveUploadIcon,
  HomeIcon,
  Share2Icon,
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
import { FlowSwitcher, LOCAL_FLOW, type Flow } from "./flow-switcher";
import { NavMicrocontroller } from "./nav-microcontroller";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/utils/trpc";
import { useActiveFlowStore } from "@/stores/active-flow-store";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const activeFlowId = useActiveFlowStore((s) => s.activeFlowId);

  const { data: cloudFlows } = useQuery({
    ...trpc.flow.list.queryOptions(),
    enabled: !!user,
  });

  const flows = React.useMemo<Flow[]>(() => {
    const allFlows: Flow[] = [LOCAL_FLOW];

    if (cloudFlows) {
      const owned = cloudFlows.owned.map((f) => ({
        id: f.id,
        name: f.name,
        description: f.description,
      }));
      const collaborated = cloudFlows.collaborated.map((f) => ({
        id: f.id,
        name: f.name,
        description: `${f.role}`,
      }));
      allFlows.push(...owned, ...collaborated);
    }

    return allFlows;
  }, [cloudFlows]);

  // Determine the flow URL based on active flow
  const flowUrl =
    activeFlowId === "local" ? "/flow/local" : `/flow/${activeFlowId}`;

  return (
    <Sidebar collapsible="icon" variant="inset" {...props}>
      <SidebarHeader>
        <FlowSwitcher flows={flows} user={user} />
      </SidebarHeader>
      <SidebarContent>
        <NavMicrocontroller />
        <NavMain
          groups={[
            {
              title: "General",
              routes: [
                {
                  title: "Dashboard",
                  url: "/",
                  icon: HomeIcon,
                },
              ],
            },
            {
              title: "Flow",
              routes: [
                {
                  title: "Edit",
                  icon: WaypointsIcon,
                  url: flowUrl,
                },
                {
                  title: "Show circuit",
                  icon: CircuitBoardIcon,
                  url: `/circuit`,
                  badge: "beta",
                },
                {
                  title: "Actions",
                  url: "/actions",
                  items: [
                    {
                      title: "Share",
                      icon: Share2Icon,
                      onClick: () => {
                        console.log("share flow");
                      },
                    },
                    {
                      title: "Export",
                      icon: HardDriveUploadIcon,
                      onClick: () => {
                        console.log("export flow");
                      },
                    },
                    {
                      title: "Import",
                      icon: HardDriveDownloadIcon,
                      onClick: () => {
                        console.log("import flow");
                      },
                    },
                  ],
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
  );
}
