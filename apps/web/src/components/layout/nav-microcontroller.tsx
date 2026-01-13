import { MicrochipIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { isDesktop } from "@/utils/platform";
import { cva, type VariantProps } from "class-variance-authority";
import { useBoardState } from "@/stores/board";
import { useMemo } from "react";

export function NavMicrocontroller() {
  if (!isDesktop()) return null;

  const boardState = useBoardState();

  const micorControllerMessage = useMemo(() => {
    switch (boardState) {
      case "connected":
        return "Connect to microcontroller";
      case "connecting":
        return "Connecting...";
      case "disconnected":
        return "No microcontroller connected";
      default:
        return "Unknown state";
    }
  }, [boardState]);

  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem title={micorControllerMessage}>
          <SidebarMenuButton
            disabled
            className={buttonVariants({ state: boardState })}
          >
            <MicrochipIcon className={iconVariants({ state: boardState })} />
            <span className={messageVariants({ state: boardState })}>
              {micorControllerMessage}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

const iconVariants = cva("stroke-3", {
  variants: {
    state: {
      connected: "stroke-green-200",
      connecting: "stroke-blue-200 animate-pulse",
      disconnected: "stroke-muted-foreground/90",
      error: "stroke-red-200",
    },
  },
  defaultVariants: {
    state: "disconnected",
  },
});

const messageVariants = cva("ellipsis", {
  variants: {
    state: {
      connected: "text-green-200",
      connecting: "text-blue-200 animate-pulse",
      disconnected: "text-muted-foreground/90",
      error: "text-red-200",
    },
  },
});

const buttonVariants = cva("", {
  variants: {
    state: {
      connected: "bg-green-900",
      connecting: "bg-blue-900 animate-pulse",
      disconnected: "bg-muted-foreground/10",
      error: "bg-red-900",
    },
  },
});
