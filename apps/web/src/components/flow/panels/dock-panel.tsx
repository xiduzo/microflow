import { DockIcon } from "@/components/ui/dock";

import { Dock } from "@/components/ui/dock";
import { Separator } from "@/components/ui/separator";
import { useReactFlow } from "@xyflow/react";
import {
  HardDriveUploadIcon,
  PlusIcon,
  RedoIcon,
  SettingsIcon,
  UndoIcon,
} from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { type MouseEvent } from "react";
import { useNewNodeStore } from "@/stores/new-node";
import { useFlowHistoryActions } from "@/stores/flow-store";
import { cn } from "@/lib/utils";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import { useNavigate } from "@tanstack/react-router";
import { useFlowImportExport } from "@/hooks/use-flow-import-export";

export function DockPanel() {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { setOpen } = useNewNodeStore();
  const history = useFlowHistoryActions();
  const navigate = useNavigate();
  const { activeFlowId } = useActiveFlowStore();
  const { exportFlow } = useFlowImportExport();

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

  const handleAddNode = () => {
    setOpen(true);
  };

  const handleSettings = () => {
    // navigate to settings page
    navigate({
      to: "/flow/$flowId/settings",
      params: { flowId: activeFlowId },
    });
  };

  useHotkeys("mod+equal", handleZoomIn, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Zoom in",
  });

  useHotkeys("mod+minus", handleZoomOut, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Zoom out",
  });

  useHotkeys("shift+1", handleZoomToFit, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Zoom to fit",
  });

  useHotkeys("mod+0", handleZoomTo100, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Zoom to 100%",
  });

  useHotkeys("mod+z", handleUndo, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Undo",
  });

  useHotkeys("mod+shift+z", handleRedo, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Redo",
  });

  useHotkeys("mod+k", handleAddNode, {
    scopes: ["flow"],
    description: "Add node",
  });

  return (
      <Dock direction="middle">
        <DockIcon onClick={handleAddNode}>
          <PlusIcon />
        </DockIcon>
        <Separator orientation="vertical" className="h-full" />
        <DockIcon onClick={handleUndo}>
          <UndoIcon className={cn(history.canUndo() ? "text-primary" : "text-muted-foreground")} />
        </DockIcon>
        <DockIcon onClick={handleRedo}>
          <RedoIcon className={cn(history.canRedo() ? "text-primary" : "text-muted-foreground")} />
        </DockIcon>
        <Separator orientation="vertical" className="h-full" />
        <DockIcon onClick={exportFlow}>
          <HardDriveUploadIcon />
        </DockIcon>
        <DockIcon onClick={handleSettings}>
          <SettingsIcon />
        </DockIcon>
      </Dock>
  );
}
