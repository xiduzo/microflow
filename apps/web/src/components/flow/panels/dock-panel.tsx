import { DockIcon } from "@/components/ui/dock";

import { Dock } from "@/components/ui/dock";
import { Separator } from "@/components/ui/separator";
import { useReactFlow } from "@xyflow/react";
import {
  BotMessageSquareIcon,
  HardDriveUploadIcon,
  NetworkIcon,
  PlusIcon,
  RedoIcon,
  SettingsIcon,
  UndoIcon,
} from "lucide-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { type MouseEvent } from "react";
import { useNewNodeStore } from "@/stores/new-node";
import { useAskAiStore } from "@/stores/ask-ai";
import { useFlowHistory, useFlowSession } from "@/session";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { useNavigate } from "@tanstack/react-router";
import { useFlowImportExport } from "@/hooks/use-flow-import-export";
import { applyAutoLayout } from "@/lib/auto-layout";

export function DockPanel() {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { setOpen } = useNewNodeStore();
  const { doc } = useFlowSession();
  const history = useFlowHistory(doc);
  const navigate = useNavigate();
  const { activeFlowId } = useAppStore();
  const { exportFlow } = useFlowImportExport();
  const askAiOpen = useAskAiStore((s) => s.open);
  const toggleAskAi = useAskAiStore((s) => s.toggle);

  const handleZoomIn = (event?: KeyboardEvent | MouseEvent) => {
    event?.stopPropagation();
    zoomIn({ duration: 250 });
  };

  const handleZoomOut = (event?: KeyboardEvent | MouseEvent) => {
    event?.stopPropagation();
    zoomOut({ duration: 250 });
  };

  const handleZoomToFit = () => {
    fitView({ duration: 250, padding: 0.25 });
  };

  const handleZoomTo100 = () => {
    zoomTo(1);
  };

  const handleUndo = () => {
    history.undo();
  };

  const handleRedo = () => {
    history.redo();
  };

  const handleAddNode = (event?: KeyboardEvent | MouseEvent) => {
    setOpen(true);
  };

  // One undo step, then frame the result — a layout you cannot see is
  // indistinguishable from nothing having happened.
  const handleAutoLayout = () => {
    applyAutoLayout(doc);
    fitView({ duration: 250, padding: 0.25 });
  };

  const handleSettings = () => {
    // navigate to settings page
    navigate({
      to: "/flow/$flowId/settings",
      params: { flowId: activeFlowId },
    });
  };

  useHotkey("Mod+=", handleZoomIn, {
    ignoreInputs: true,
    meta: { name: "Zoom in", description: "Zoom in" },
  });

  useHotkey("Mod+-", handleZoomOut, {
    ignoreInputs: true,
    meta: { name: "Zoom out", description: "Zoom out" },
  });

  useHotkey("Shift+1", handleZoomToFit, {
    ignoreInputs: true,
    meta: { name: "Zoom to fit", description: "Zoom to fit" },
  });

  useHotkey("Mod+0", handleZoomTo100, {
    ignoreInputs: true,
    meta: { name: "Zoom to 100%", description: "Zoom to 100%" },
  });

  useHotkey("Mod+Z", handleUndo, {
    ignoreInputs: true,
    meta: { name: "Undo", description: "Undo" },
  });

  useHotkey("Mod+Shift+Z", handleRedo, {
    ignoreInputs: true,
    meta: { name: "Redo", description: "Redo" },
  });

  useHotkey("Shift+L", handleAutoLayout, {
    ignoreInputs: true,
    meta: { name: "Auto layout", description: "Arrange the flow left to right" },
  });

  useHotkey("Mod+K", handleAddNode, {
    meta: { name: "Add node", description: "Add node" },
    preventDefault: true,
  });

  return (
    <Dock direction="middle">
      <DockIcon onClick={handleAddNode}>
        <PlusIcon />
      </DockIcon>
      <Separator orientation="vertical" className="h-full" />
      <DockIcon onClick={handleUndo}>
        <UndoIcon className={cn(history.canUndo ? "text-primary" : "text-muted-foreground")} />
      </DockIcon>
      <DockIcon onClick={handleRedo}>
        <RedoIcon className={cn(history.canRedo ? "text-primary" : "text-muted-foreground")} />
      </DockIcon>
      <DockIcon onClick={handleAutoLayout}>
        <NetworkIcon />
      </DockIcon>
      <Separator orientation="vertical" className="h-full" />
      {/* Lives with the canvas tools, not in navigation: it edits the flow in
          front of you rather than taking you somewhere. */}
      <DockIcon onClick={toggleAskAi}>
        <BotMessageSquareIcon className={cn(askAiOpen && "text-primary")} />
      </DockIcon>
      <Separator orientation="vertical" className="h-full" />
      <DockIcon onClick={exportFlow}>
        <HardDriveUploadIcon />
      </DockIcon>
      {activeFlowId !== "local" && (
        <DockIcon onClick={handleSettings}>
          <SettingsIcon />
        </DockIcon>
      )}
    </Dock>
  );
}
