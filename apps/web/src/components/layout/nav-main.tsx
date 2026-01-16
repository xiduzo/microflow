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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { useNavigate, useLocation } from "@tanstack/react-router";

export function NavMain(props: Props) {
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
                    <SidebarMenuItem title={route.title}>
                      <CollapsibleTrigger render={<div />} nativeButton={false} className="w-full">
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
                            return (
                              <SidebarMenuSubItem key={subItem.title}>
                                <LinkOrAction item={subItem} />
                                <SidebarMenuBadge className="text-muted-foreground">
                                  {subItem.badge}
                                </SidebarMenuBadge>
                              </SidebarMenuSubItem>
                            );
                          })}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              }
              return (
                <SidebarMenuItem key={route.title}>
                  <LinkOrAction item={route} />
                  <SidebarMenuBadge className="text-muted-foreground">
                    {route.badge}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  );
}

function LinkOrAction({ item }: { item: Item }) {
  const navigate = useNavigate();

  return (
    <SidebarMenuButton
      tooltip={item.title}
      onClick={() => {
        "url" in item ? navigate({ to: item.url }) : item.onClick();
      }}
    >
      {item.icon && <item.icon />}
      <span>{item.title}</span>
    </SidebarMenuButton>
  );
}

type BaseItem = {
  title: string;
  icon?: LucideIcon;
  badge?: string;
};

type LinkItem = BaseItem & {
  url: string;
};

type ActionItem = BaseItem & {
  onClick: () => void;
};

type Item = LinkItem | ActionItem;

type Route = Item & {
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
