import {
  ExternalLinkIcon,
  FileCodeIcon,
  LoaderPinwheelIcon,
  MicrochipIcon,
  OctagonAlertIcon,
  OctagonXIcon,
  UsbIcon,
  type LucideIcon,
} from "lucide-react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { isDesktop } from "@/utils/platform";
import { cva } from "class-variance-authority";
import { useBoardPort, useBoardState } from "@/stores/board";
import { useMemo } from "react";

export function NavMicrocontroller() {
  if (!isDesktop()) return null

  const boardState = useBoardState();
  const port = useBoardPort();

  const { message, Icon } = useMemo((): {
    message: string;
    Icon: LucideIcon;
  } => {
    switch (boardState) {
      case "connected":
        return { message: port ?? "Connected", Icon: MicrochipIcon };
      case "connecting":
        return { message: "Connecting", Icon: LoaderPinwheelIcon };
      case "flashing":
        return { message: "Flashing firmware", Icon: FileCodeIcon };
      case "disconnected":
        return { message: "No microcontroller connected", Icon: UsbIcon };
      case "error":
        return { message: "Error", Icon: OctagonAlertIcon };
      default:
        return { message: "Unknown state", Icon: OctagonXIcon };
    }
  }, [boardState, port]);

  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem title={message}>
          <SidebarMenuButton
            disabled
            className={buttonVariants({ state: boardState })}
          >
            <Icon />
            <span>{message}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

const buttonVariants = cva("", {
  variants: {
    state: {
      connected: "bg-green-900 stroke-green-200 text-green-200",
      connecting:
        "bg-blue-900 animate-pulse text-blue-200 stroke-blue-200 [&_svg]:animate-spin",
      flashing:
        "bg-yellow-900 animate-pulse text-yellow-200 stroke-yellow-200 [&_svg]:animate-pulse",
      disconnected:
        "bg-muted-foreground/10 text-muted-foreground/90 stroke-muted-foreground/90",
      error: "bg-red-900 text-red-200 stroke-red-200",
    },
  },
});
