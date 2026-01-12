import * as React from "react";
import {
  BookIcon,
  BookMarkedIcon,
  LifeBuoy,
  type LucideIcon,
} from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type Link = {
  title: string;
  url: string;
  icon: LucideIcon;
};

const LINKS: Link[] = [
  {
    title: "Documentation",
    url: "https://microflow.vercel.app/docs",
    icon: BookMarkedIcon,
  },
];

export function NavSecondary(
  props: React.ComponentPropsWithoutRef<typeof SidebarGroup>
) {
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {LINKS.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton size="sm">
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
