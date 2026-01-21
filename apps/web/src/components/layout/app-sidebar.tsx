import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookCheckIcon,
  BookIcon,
  BookSearchIcon,
  CircuitBoardIcon,
  CuboidIcon,
  GraduationCapIcon,
  HandshakeIcon,
  HardDriveDownloadIcon,
  HardDriveUploadIcon,
  HomeIcon,
  LibraryBigIcon,
  NotebookTabsIcon,
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
import { useFlowImportExport } from "@/hooks/use-flow-import-export";
import { useMemo } from "react";
import { isDesktop } from "@/lib/platform";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const activeFlowId = useActiveFlowStore((s) => s.activeFlowId);
  const { exportFlow, importFlow } = useFlowImportExport();

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


  // Determine the flow URL based on active flow
  const flowUrl = `/${activeFlow.id}/flow`;

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
                    url: flowUrl,
                  },
                  {
                    title: "Show circuit",
                    icon: CircuitBoardIcon,
                    url: `/${activeFlow.id}/circuit`,
                    badge: "beta",
                  },
                  ...(activeFlow.id !== "local"
                    ? [
                      {
                        title: "Settings",
                        icon: SettingsIcon,
                        url: `/${activeFlow.id}/settings`,
                      },
                    ]
                    : []),
                  {
                    title: "Actions",
                    url: "/actions",
                    items: [
                      {
                        title: "Export",
                        icon: HardDriveUploadIcon,
                        onClick: exportFlow,
                      },
                      {
                        title: "Import",
                        icon: HardDriveDownloadIcon,
                        onClick: importFlow,
                      },
                    ],
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
                    icon: BookSearchIcon,
                  },
                  {
                    title: "Templates",
                    url: "/templates",
                    icon: LibraryBigIcon,
                  },
                  {
                    title: "Learning",
                    url: "/learning",
                    icon: GraduationCapIcon,
                  },
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