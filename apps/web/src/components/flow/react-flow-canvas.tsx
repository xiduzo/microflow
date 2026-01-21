import {
  Background,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type ColorMode,
  type XYPosition,
  type Connection,
} from "@xyflow/react";
import {
  useFlowDocument,
  useFlowClipboard,
  useFlowHistoryActions,
} from "@/stores/flow-store";
import { useFlowState } from "@/hooks/use-flow-document";
import type { AwarenessUser, FlowEdge } from "@microflow/collab";

import "@xyflow/react/dist/style.css";
import { NODE_TYPES } from "./nodes/_TYPES";
import { NewNodeDialog } from "./dialogs/new-node-dialog";
import { SettingsPanel } from "./panels/settings-panel";
import { useEffect, useRef, useCallback } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { EDGE_TYPES } from "./edges/edges.constants";
import { DockPanel } from "./panels/dock-panel";
import { useTheme } from "@/providers/theme-provider";
import { HotkeySheet } from "./sheets/hotkey-sheet";
import { CollabCursors } from "./collab-cursors";
import { PressensePanel } from "./panels/pressense-panel";

const uid = () => Math.random().toString(36).substring(2, 9);

type ReactFlowCanvasProps = {
  updateCursor?: (cursor: { x: number; y: number }) => void;
  otherUsers?: AwarenessUser[];
};

export function ReactFlowCanvas({
  updateCursor,
  otherUsers = [],
}: ReactFlowCanvasProps) {
  const { fitView } = useReactFlow();
  const { theme } = useTheme();

  // Get FlowDocument
  const flowDoc = useFlowDocument();

  // Use the integrated flow state hook
  const { nodes, edges, onNodesChange, onEdgesChange } = useFlowState(flowDoc);

  // Handle new connections
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!flowDoc) return;

      const newEdge: FlowEdge = {
        id: uid(),
        source: connection.source!,
        sourceHandle: connection.sourceHandle ?? undefined,
        target: connection.target!,
        targetHandle: connection.targetHandle ?? undefined,
        type: "animated",
      };

      flowDoc.addEdge(newEdge);
    },
    [flowDoc]
  );

  // Setup hotkeys
  useHelperHotkeys(nodes);

  // Handle cursor tracking for collab
  const { screenToFlowPosition } = useReactFlow();
  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!updateCursor) return;
      const flowPosition = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      updateCursor(flowPosition);
    },
    [updateCursor, screenToFlowPosition]
  );

  useEffect(() => {
    fitView({ duration: 250, padding: 0.15 });
  }, [fitView, flowDoc?.meta.doc?.clientID]);

  return (
    <div className="w-full h-full relative overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onMouseMove={handleMouseMove}
        onConnect={onConnect}
        colorMode={(theme as ColorMode) ?? "system"}
        minZoom={0.05}
        maxZoom={1}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        selectNodesOnDrag={false}
        fitViewOptions={{ padding: 0.15 }}
        className="rounded-3xl relative"
      >
        <MiniMap nodeBorderRadius={6} pannable zoomable />
        <Background gap={140} />
        <NewNodeDialog />
        <HotkeySheet />
        <Panel position="top-right">
          <SettingsPanel />
        </Panel>
        <Panel position="bottom-center">
          <DockPanel />
        </Panel>
        <Panel position="top-left">
          <PressensePanel users={otherUsers} />
        </Panel>
      </ReactFlow>
      <CollabCursors users={otherUsers} />
    </div>
  );
}

function useHelperHotkeys(nodes: Array<{ id: string; selected?: boolean }>) {
  const cursorPositionRef = useRef<XYPosition>({ x: 0, y: 0 });

  const { fitView, screenToFlowPosition } = useReactFlow();

  const clipboard = useFlowClipboard();
  const history = useFlowHistoryActions();

  useHotkeys("meta+c", clipboard.copy, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
  });

  useHotkeys(
    "meta+v",
    () => {
      clipboard.paste(screenToFlowPosition(cursorPositionRef.current));
    },
    {
      enabled: true,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    }
  );

  useHotkeys("meta+a", clipboard.selectAll, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
  });

  useHotkeys("meta+z", history.undo, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
  });

  useHotkeys("meta+shift+z", history.redo, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
  });

  useHotkeys(
    "shift+1",
    () => {
      const selectedNodes = nodes.filter((node) => node.selected);
      fitView({
        nodes: selectedNodes.length ? selectedNodes : nodes,
        padding: 0.25,
        duration: 250,
      });
    },
    {
      enabled: true,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    }
  );

  useEffect(() => {
    function handleMouseMove(event: MouseEvent) {
      cursorPositionRef.current = { x: event.clientX, y: event.clientY };
    }

    document.addEventListener("mousemove", handleMouseMove);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);
}
