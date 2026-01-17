import {
  ChevronsUpDown,
  LogIn,
  Plus,
  Check,
} from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";

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
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { CreateFlowDialog } from "@/components/flow/dialogs/create-flow-dialog";

export const LOCAL_FLOW: Flow = {
  id: "local",
  name: "Local Flow",
  description: "Stored on this device",
};

export function FlowSwitcher(props: Props) {
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const isSignedIn = !!props.user;
  const { activeFlowId, setActiveFlowId } = useActiveFlowStore();

  const activeFlow =
    props.flows.find(({ id }) => id === activeFlowId) ?? LOCAL_FLOW;

  const handleFlowSelect = (flow: Flow) => {
    setActiveFlowId(flow.id);
    // Navigate to the appropriate route based on flow type
    if (flow.id === "local") {
      navigate({ to: "/flow/local" });
    } else {
      navigate({ to: "/flow/$flowId", params: { flowId: flow.id } });
    }
  };

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
            />
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
                  key={flow.id}
                  className="gap-2 p-2"
                  onClick={() => handleFlowSelect(flow)}
                >
                  <div
                    className="flex size-6 items-center justify-center rounded-md text-xs font-medium text-white"
                    style={{
                      backgroundColor: flow.color ?? "var(--sidebar-primary)",
                    }}
                  />
                  <span className="flex-1 truncate">{flow.name}</span>
                  {flow.id === activeFlowId && (
                    <Check className="size-4 text-primary" />
                  )}
                  {index < 9 && (
                    <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {isSignedIn ? (
              <CreateFlowDialog
                trigger={
                  <DropdownMenuItem
                    className="gap-2 p-2"
                    onSelect={(e) => e.preventDefault()}
                  >
                    <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                      <Plus className="size-4" />
                    </div>
                    <div className="text-muted-foreground font-medium">
                      Add flow
                    </div>
                  </DropdownMenuItem>
                }
              />
            ) : (
              <DropdownMenuItem
                className="gap-2 p-2"
                render={<Link to="/login" />}
              >
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

export type Flow = {
  id: string;
  name: string;
  color?: string;
  description?: string | null;
};

type User = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
} | null;

type Props = {
  flows: Flow[];
  user: User;
};
