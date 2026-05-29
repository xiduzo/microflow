import { DockIcon } from "@/components/ui/dock";

import { Dock } from "@/components/ui/dock";
import { Separator } from "@/components/ui/separator";
import { useReactFlow } from "@xyflow/react";
import {
  CodeIcon,
  HardDriveUploadIcon,
  PlusIcon,
  RedoIcon,
  SettingsIcon,
  UndoIcon,
} from "lucide-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { type MouseEvent } from "react";
import { useNewNodeStore } from "@/stores/new-node";
import { useFlowHistory, useFlowSession } from "@/session";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { useNavigate } from "@tanstack/react-router";
import { useFlowImportExport } from "@/hooks/use-flow-import-export";
import { useSketchCodeViewStore } from "@/stores/sketch-code-view";

export function DockPanel() {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { setOpen } = useNewNodeStore();
  const { doc } = useFlowSession();
  const history = useFlowHistory(doc);
  const navigate = useNavigate();
  const { activeFlowId } = useAppStore();
  const { exportFlow } = useFlowImportExport();
  const { setOpen: setSketchCodeViewOpen } = useSketchCodeViewStore();

  const handleViewCode = () => {
    setSketchCodeViewOpen(true);
  };

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
      <Separator orientation="vertical" className="h-full" />
      <DockIcon onClick={handleViewCode}>
        <CodeIcon />
      </DockIcon>
      <DockIcon onClick={exportFlow}>
        <HardDriveUploadIcon />
      </DockIcon>
      <DockIcon onClick={handleSettings}>
        <SettingsIcon />
      </DockIcon>
    </Dock>
  );
}
