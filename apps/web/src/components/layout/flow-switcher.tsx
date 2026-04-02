import { ChevronsUpDown, LogIn, Plus, Check } from "lucide-react";
import { Link, useMatch, useMatches, useNavigate } from "@tanstack/react-router";

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
import { useHotkey } from "@tanstack/react-hotkeys";
import { useIsMac } from "@/hooks/is-mac";
import { useState } from "react";

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

export type FlowSwitcherProps = {
  flows: Flow[];
  user: User;
  activeFlowDescription?: string;
};

export const LOCAL_FLOW: Flow = {
  id: "local",
  name: "Local Flow",
  description: "Stored on this device",
};

export function FlowSwitcher(props: FlowSwitcherProps) {
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const isMac = useIsMac();
  const isSignedIn = !!props.user;
  const { activeFlowId, setActiveFlowId } = useActiveFlowStore();
  const matches = useMatches()
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const activeFlow =
    props.flows.find(({ id }) => id === activeFlowId) ?? LOCAL_FLOW;

  // Use provided description or fall back to flow's description
  const displayDescription =
    props.activeFlowDescription ?? activeFlow.description;

  const handleFlowSelect = (flow: Flow) => {
    setActiveFlowId(flow.id);

    const route = matches[matches.length - 1].routeId;

    if (route === "/flow/$flowId/graph" || route === "/flow/$flowId/circuit" || route === "/flow/$flowId/settings") {
      navigate({
        from: route,
        params: (prev) => ({ ...prev, flowId: flow.id }),
        replace: true,
      });
      return
    }

    // Navigate to the flow graph when not already on a flow route
    navigate({
      to: "/flow/$flowId/graph",
      params: { flowId: flow.id },
    });
  };

  const handleHotkeyShortcut = (index: number) => {
    const flow = props.flows[index];
    if (!flow) return
    handleFlowSelect(flow);
  };

  return (
    <SidebarMenu>
      <>
        {Array.from({ length: 9 }).map((_, index) => (
          <HotkeyShortcut key={index} index={index} callback={handleHotkeyShortcut} />
        ))}
      </>
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
              className="aspect-square size-8 rounded-lg bg-card-foreground"
              style={{
                backgroundColor: activeFlow.color ?? "var(--foreground)",
              }}
            />
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{activeFlow.name}</span>
              {displayDescription && (
                <span className="truncate text-xs text-muted-foreground">
                  {displayDescription}
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
                    className="size-6 rounded-md"
                    style={{
                      backgroundColor: flow.color ?? "var(--foreground)",
                    }}
                  />
                  <span className="flex-1 truncate">{flow.name}</span>
                  {flow.id === activeFlowId && (
                    <Check className="size-4 text-primary" />
                  )}
                  {index < 9 && (
                    <DropdownMenuShortcut>{isMac ? "⌘" : "ctrl+"}{index + 1}</DropdownMenuShortcut>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {isSignedIn ? (
              <DropdownMenuItem
                className="gap-2 p-2"
                onClick={() => {
                  // Delay to let the dropdown finish closing before opening the dialog
                  requestAnimationFrame(() => setCreateDialogOpen(true));
                }}
              >
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <Plus className="size-4" />
                </div>
                <div className="text-muted-foreground font-medium">
                  Add flow
                </div>
              </DropdownMenuItem>
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
      {isSignedIn && (
        <CreateFlowDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      )}
    </SidebarMenu>
  );
}

function HotkeyShortcut(props: { index: number, callback: (index: number) => void }) {
  useHotkey({ key: String(props.index + 1), mod: true }, () => {
    props.callback(props.index);
  }, {
    ignoreInputs: true,
  });
  return null
}