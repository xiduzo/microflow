import * as React from "react";
import { BookMarkedIcon, HeartIcon, type LucideIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { isDesktop } from "@/lib/platform";

type Link = {
  title: string;
  url: string;
  icon: LucideIcon;
  tooltip?: string;
};

const LINKS: Link[] = [
  {
    title: "Documentation",
    url: "https://microflow.vercel.app/docs",
    icon: BookMarkedIcon,
  },
  {
    title: "By xiduzo",
    tooltip: "Made with ♥ by xiduzo",
    url: "https://sanderboer.nl",
    icon: HeartIcon,
  },
];

export function NavSecondary(
  props: React.ComponentPropsWithoutRef<typeof SidebarGroup>
) {

  const handleLinkClick = (url: string) => {
    if (isDesktop()) {
      return
    }

    window.open(url, "_blank")
  }
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {LINKS.map((item) => (
            <SidebarMenuItem
              key={item.title}
              title={item.tooltip ?? item.title}
            >
              <SidebarMenuButton
                size="sm"
                tooltip={item.tooltip ?? item.title}
                onClick={() => handleLinkClick(item.url)}
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
