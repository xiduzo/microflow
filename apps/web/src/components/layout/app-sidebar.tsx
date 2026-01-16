import * as React from "react";
import {
  CircuitBoardIcon,
  DotSquareIcon,
  HardDriveDownloadIcon,
  HardDriveUploadIcon,
  HomeIcon,
  Share2Icon,
  SquareMousePointerIcon,
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
import { useMemo } from "react";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;

  const flows = useMemo(() => {
    if (!user) return [LOCAL_FLOW];

    return [
      {
        id: "1",
        name: "Flow 1",
        color: "#ffcc00",
        description: "by John Doe",
      },
    ];
  }, [user]);

  return (
    <Sidebar collapsible="icon" variant="inset" {...props}>
      <SidebarHeader>
        <FlowSwitcher
          activeFlowId={user ? "1" : "local"}
          flows={flows}
          user={user}
        />
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
                  url: `/flow`, // TODO: add active flow ID?
                },
                {
                  title: "Show circuit",
                  icon: CircuitBoardIcon,
                  url: `/circuit`, // TODO: add active circuit ID
                  badge: "beta",
                },
              ],
            },
            {
              title: "Actions",
              routes: [
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
