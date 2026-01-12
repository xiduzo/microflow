import { DockIcon } from "@/components/ui/dock";

import { Dock } from "@/components/ui/dock";
import { Separator } from "@/components/ui/separator";
import { useReactFlow } from "@xyflow/react";
import {
  FullscreenIcon,
  PlusIcon,
  RedoIcon,
  UndoIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { type MouseEvent } from "react";
import { useNewNodeStore } from "@/stores/new-node";
import { useIsMac } from "@/hooks/is-mac";

export function DockPanel() {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { setOpen } = useNewNodeStore();
  const isMac = useIsMac();

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
    console.log("undo");
    // undo();
  };

  const handleRedo = () => {
    console.log("redo");
    // redo();
  };

  const handleAddNode = () => {
    setOpen(true);
  };

  useHotkeys(isMac ? "meta+equal" : "ctrl+equal", handleZoomIn, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Zoom in",
  });

  useHotkeys(isMac ? "meta+minus" : "ctrl+minus", handleZoomOut, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Zoom out",
  });

  useHotkeys("shit+1", handleZoomToFit, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Zoom to fit",
  });

  useHotkeys(isMac ? "meta+0" : "ctrl+0", handleZoomTo100, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Zoom to 100%",
  });

  useHotkeys(isMac ? "meta+z" : "ctrl+z", handleUndo, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Undo",
  });

  useHotkeys(isMac ? "meta+shift+z" : "ctrl+shift+z", handleRedo, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
    description: "Redo",
  });

  useHotkeys(isMac ? "meta+k" : "ctrl+k", handleAddNode, {
    scopes: ["flow"],
    description: "Add node",
  });

  return (
    <div className="relative">
      <Dock direction="middle">
        <DockIcon onClick={handleUndo}>
          <UndoIcon />
        </DockIcon>
        <DockIcon onClick={handleRedo}>
          <RedoIcon />
        </DockIcon>
        <Separator orientation="vertical" className="h-full" />
        <DockIcon>
          <PlusIcon onClick={handleAddNode} />
        </DockIcon>
        <Separator orientation="vertical" className="h-full" />
        <DockIcon onClick={handleZoomIn}>
          <ZoomInIcon />
        </DockIcon>
        <DockIcon onClick={handleZoomOut}>
          <ZoomOutIcon />
        </DockIcon>
        <DockIcon onClick={handleZoomToFit}>
          <FullscreenIcon />
        </DockIcon>
      </Dock>
    </div>
  );
}
