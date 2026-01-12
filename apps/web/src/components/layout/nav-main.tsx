import { ChevronRight, type LucideIcon } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";

export function NavMain(props: Props) {
  const { data: session, isPending } = authClient.useSession();

  console.log(session, isPending);

  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname;

  const isActive = (link: Route | Item) => {
    const isInternal = "url" in link;
    if (!isInternal) return false;

    const url = (link as LinkItem).url;
    // Exact match
    if (currentPath === url) return true;

    // For routes that might have trailing slashes, normalize comparison
    const normalizedCurrent = currentPath.replace(/\/$/, "");
    const normalizedUrl = url.replace(/\/$/, "");
    if (normalizedCurrent === normalizedUrl) return true;

    return false;
  };

  return (
    <>
      {props.groups.map((group, groupIndex) => (
        <SidebarGroup key={group.title || `group-${groupIndex}`}>
          {group.title && <SidebarGroupLabel>{group.title}</SidebarGroupLabel>}
          <SidebarMenu>
            {group.routes.map((route) => {
              const hasChildren = route.items && route.items.length > 0;
              const itemIsActive = isActive(route) || route.isActive;

              if (hasChildren) {
                // Check if any sub-item is active
                const hasActiveChild =
                  route.items?.some((subItem) => isActive(subItem)) ?? false;
                const shouldBeOpen =
                  itemIsActive || hasActiveChild || route.isActive;

                return (
                  <Collapsible
                    key={route.title}
                    defaultOpen={shouldBeOpen}
                    className="group/collapsible"
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger className="w-full">
                        <SidebarMenuButton
                          tooltip={route.title}
                          isActive={itemIsActive}
                        >
                          {route.icon && <route.icon />}
                          <span>{route.title}</span>
                          <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {route.items?.map((subItem) => {
                            const subItemIsActive = isActive(subItem);
                            const isInternal = "url" in subItem;
                            if (!isInternal) return null;
                            return (
                              <SidebarMenuSubItem key={subItem.title}>
                                <SidebarMenuSubButton
                                  className="w-full"
                                  isActive={subItemIsActive}
                                  onClick={() => navigate({ to: subItem.url })}
                                >
                                  <span>{subItem.title}</span>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            );
                          })}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              }

              const isInternal = "url" in route;
              if (!isInternal) return null;

              return (
                <SidebarMenuItem key={route.title}>
                  <SidebarMenuButton
                    tooltip={route.title}
                    isActive={itemIsActive}
                    onClick={() => {
                      navigate({ to: route.url });
                    }}
                  >
                    {route.icon && <route.icon />}
                    <span>{route.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  );
}

type BaseItem = {
  title: string;
  icon?: LucideIcon;
};

type LinkItem = BaseItem & {
  url: string;
};

type ActionItem = BaseItem & {
  onClick: () => void;
};

type Item = LinkItem | ActionItem;

type Route = LinkItem & {
  isActive?: boolean;
  items?: Item[];
};

export type Group = {
  title?: string;
  routes: Route[];
};

type Props = {
  groups: Group[];
};
