import { ChevronsUpDown, LogIn, Plus } from "lucide-react";
import { Link } from "@tanstack/react-router";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export const LOCAL_FLOW: Flow = {
  id: "local",
  name: "Local Flow",
  description: "Stored on this device",
};

export function FlowSwitcher(props: Props) {
  const { isMobile } = useSidebar();
  const isSignedIn = !!props.user;

  const activeFlow = props.flows.find(({ id }) => id === props.activeFlowId);

  if (!activeFlow) return null;

  //   if (!activeTeam) {
  //     return null;
  //   }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="w-full"
            render={
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent w-full data-[state=open]:text-sidebar-accent-foreground"
              />
            }
          >
            <div
              className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg"
              style={{
                backgroundColor: activeFlow.color ?? "var(--sidebar-primary)",
              }}
            >
              {/* <activeTeam.logo className="size-4" /> */}
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{activeFlow.name}</span>
              {activeFlow.description && (
                <span className="truncate text-xs text-muted-foreground">
                  {activeFlow.description}
                </span>
              )}
            </div>
            <ChevronsUpDown className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                Flows
              </DropdownMenuLabel>
              {props.flows.map((flow, index) => (
                <DropdownMenuItem
                  key={flow.name}
                  className="gap-2 p-2"
                >
                  <div
                    className="flex size-6 items-center justify-center rounded-md"
                    style={{
                      backgroundColor: flow.color ?? "var(--sidebar-primary)",
                    }}
                  >
                    {/* <team.logo className="size-3.5 shrink-0" /> */}
                  </div>
                  {flow.name}
                  <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {isSignedIn ? (
              <DropdownMenuItem className="gap-2 p-2">
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <Plus className="size-4" />
                </div>
                <div className="text-muted-foreground font-medium">Add flow</div>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem className="gap-2 p-2" render={<Link to="/login" />}>
                <div className="flex size-6 items-center justify-center rounded-md bg-sidebar-secondary">
                  <LogIn className="size-3" />
                </div>
                <div className="text-muted-foreground font-medium">
                  Sign in to add more flows
                </div>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

type Flow = {
  id: string;
  name: string;
  color?: string;
  description?: string;
};

type User = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
} | null;

type Props = {
  flows: Flow[];
  activeFlowId?: string;
  user: User;
};
