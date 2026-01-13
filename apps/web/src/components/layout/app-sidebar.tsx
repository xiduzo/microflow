import * as React from "react";
import {
  HardDriveDownloadIcon,
  HardDriveUploadIcon,
  HomeIcon,
  Share2Icon,
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
import { FlowSwitcher } from "./flow-switcher";
import { NavMicrocontroller } from "./nav-microcontroller";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" variant="inset" {...props}>
      <SidebarHeader>
        <FlowSwitcher
          activeFlowId="1"
          flows={[
            {
              id: "1",
              name: "Flow 1",
              color: "#ffcc00",
              sharedBy: "John Doe",
            },
          ]}
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
                  title: "Export flow",
                  icon: HardDriveUploadIcon,
                  onClick: () => {
                    console.log("export flow");
                  },
                },
                {
                  title: "Import flow",
                  url: "/import",
                  icon: HardDriveDownloadIcon,
                  onClick: () => {
                    console.log("import flow");
                  },
                },
                {
                  title: "Share flow",
                  url: "/share",
                  icon: Share2Icon,
                },
              ],
            },
          ]}
        />
        <NavSecondary className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
