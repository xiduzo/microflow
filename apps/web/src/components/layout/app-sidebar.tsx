import * as React from "react";
import { HardDriveDownloadIcon, HardDriveUploadIcon } from "lucide-react";

import { NavMain } from "@/components/layout/nav-main";
import { NavSecondary } from "@/components/layout/nav-secondary";
import { NavUser } from "@/components/layout/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { FlowSwitcher } from "./flow-switcher";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="inset" {...props}>
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
        <NavMain
          groups={[
            {
              title: "Flow",
              routes: [
                {
                  title: "Export flow",
                  url: "/export",
                  icon: HardDriveDownloadIcon,
                },
                {
                  title: "Import flow",
                  url: "/import",
                  icon: HardDriveUploadIcon,
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
    </Sidebar>
  );
}
