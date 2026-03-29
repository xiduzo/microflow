import { DownloadIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { isDesktop } from "@/lib/platform";
import { DownloadStudioDialog } from "./download-studio-dialog";

export function NavDownloadStudio() {
  if (isDesktop()) return null;

  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem>
          <DownloadStudioDialog
            trigger={
              <SidebarMenuButton className="bg-primary/10 text-primary stroke-primary hover:bg-primary/20">
                <DownloadIcon />
                <span>Get Microflow Studio</span>
              </SidebarMenuButton>
            }
          />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
