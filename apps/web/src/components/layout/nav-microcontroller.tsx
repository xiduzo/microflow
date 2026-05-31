import {
  FileCodeIcon,
  LoaderPinwheelIcon,
  MicrochipIcon,
  OctagonAlertIcon,
  OctagonXIcon,
  PlugZapIcon,
  UsbIcon,
  type LucideIcon,
} from "lucide-react";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { isDesktop } from "@/lib/platform";
import { cva } from "class-variance-authority";
import { useBoardPort, useBoardState } from "@/stores/board";
import { useWebSerialBoard } from "@/hooks/use-web-serial-board";
import { useMemo } from "react";

export function NavMicrocontroller() {
  const boardState = useBoardState();
  const port = useBoardPort();
  const webSerial = useWebSerialBoard();
  const desktop = isDesktop();

  const { message, Icon } = useMemo((): { message: string; Icon: LucideIcon } => {
    switch (boardState) {
      case "connected":
        return { message: port ?? "Connected", Icon: MicrochipIcon };
      case "connecting":
        return { message: "Connecting", Icon: LoaderPinwheelIcon };
      case "flashing":
        return { message: "Flashing firmware", Icon: FileCodeIcon };
      case "disconnected":
        return desktop
          ? { message: "No microcontroller connected", Icon: UsbIcon }
          : { message: "Connect board", Icon: PlugZapIcon };
      case "error":
        return { message: "Error", Icon: OctagonAlertIcon };
      default:
        return { message: "Unknown state", Icon: OctagonXIcon };
    }
  }, [boardState, port, desktop]);

  // Web browser without Web Serial (Firefox/Safari): nudge to a Chromium
  // browser or the desktop app — there is no way to reach a serial port here.
  if (!desktop && !webSerial.supported) {
    return (
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem title="Web Serial is only available in Chrome, Edge, or Opera">
            <SidebarMenuButton disabled className={buttonVariants({ state: "disconnected" })}>
              <UsbIcon />
              <span>Use Chrome/Edge or the desktop app</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    );
  }

  // Desktop auto-detects the board in Rust — the status button is informational.
  // In the browser it is interactive: click to authorise / connect / disconnect.
  // Connect now folds in flashing automatically (probe → flash-if-missing →
  // connect), so there is no separate Flash button.
  const interactive =
    !desktop && (boardState === "disconnected" || boardState === "error" || boardState === "connected");

  const onClick = () => {
    if (desktop) return;
    if (boardState === "connected") {
      void webSerial.disconnect();
    } else if (boardState === "disconnected" || boardState === "error") {
      void webSerial.connect();
    }
  };

  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem title={message}>
          <SidebarMenuButton
            disabled={!interactive}
            onClick={interactive ? onClick : undefined}
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
      connecting: "bg-blue-900 animate-pulse text-blue-200 stroke-blue-200 [&_svg]:animate-spin",
      flashing:
        "bg-yellow-900 animate-pulse text-yellow-200 stroke-yellow-200 [&_svg]:animate-pulse",
      disconnected: "bg-muted-foreground/10 text-muted-foreground/90 stroke-muted-foreground/90",
      error: "bg-red-900 text-red-200 stroke-red-200",
    },
  },
});
