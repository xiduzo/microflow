import * as React from "react";
import { BookMarkedIcon, HeartIcon, HeartPlusIcon, type LucideIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { isDesktop } from "@/lib/platform";
import { openUrl } from "@tauri-apps/plugin-opener";

type LinkItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  tooltip?: string;
  internal?: boolean;
};

const LINKS: LinkItem[] = [
  {
    title: "Support Microflow",
    url: "/support",
    icon: HeartPlusIcon,
    internal: true,
  },
  {
    title: "Documentation",
    url: "https://docs.microflow.tech",
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
  const navigate = useNavigate();

  const handleClick = (item: LinkItem) => {
    if (item.internal) {
      navigate({ to: item.url });
      return;
    }
    if (isDesktop()) {
      openUrl(item.url);
      return;
    }
    window.open(item.url, "_blank");
  };

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
                onClick={() => handleClick(item)}
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
