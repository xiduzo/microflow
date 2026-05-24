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
  useFlowSession,
  useFlowHistory,
  useReactFlowBridge,
  useCollabPresence,
  useFlowAwareness,
} from "@/session";
import { useClipboardStore } from "@/stores/clipboard-store";
import type { FlowEdge, FlowNode } from "@microflow/collab";

import "@xyflow/react/dist/style.css";
import { NODE_TYPES } from "./nodes/_REGISTRY";
import { NewNodeDialog } from "./dialogs/new-node-dialog";
import { SettingsPanel } from "./panels/settings-panel";
import { useEffect, useRef, useCallback } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { EDGE_TYPES } from "./edges/edges.constants";
import { DockPanel } from "./panels/dock-panel";
import { useTheme } from "@/providers/theme-provider";
import { HotkeySheet } from "./sheets/hotkey-sheet";
import { CollabCursors } from "./collab-cursors";
import { PressensePanel } from "./panels/pressense-panel";

const uid = () => Math.random().toString(36).substring(2, 9);

export function ReactFlowCanvas() {
  const { fitView } = useReactFlow();
  const { theme } = useTheme();

  const { doc } = useFlowSession();
  const { otherUsers } = useCollabPresence();
  const { updateCursor } = useFlowAwareness();

  const { nodes, edges, onNodesChange, onEdgesChange } = useReactFlowBridge(doc);

  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge: FlowEdge = {
        id: uid(),
        source: connection.source!,
        sourceHandle: connection.sourceHandle ?? undefined,
        target: connection.target!,
        targetHandle: connection.targetHandle ?? undefined,
        type: "animated",
      };
      doc.addEdge(newEdge);
    },
    [doc],
  );

  useHelperHotkeys(nodes);

  const { screenToFlowPosition } = useReactFlow();
  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      updateCursor(flowPosition);
    },
    [updateCursor, screenToFlowPosition],
  );

  useEffect(() => {
    fitView({ duration: 250, padding: 0.15 });
  }, [fitView, doc.doc.clientID]);

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
        <Background gap={260} size={2} />
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

  const { fitView, screenToFlowPosition, getNodes, getEdges, setNodes, setEdges } = useReactFlow();

  const { doc } = useFlowSession();
  const history = useFlowHistory(doc);
  const copy = useClipboardStore((s) => s.copy);
  const paste = useClipboardStore((s) => s.paste);

  useHotkeys([
    {
      hotkey: "Mod+C",
      callback: () => {
        const selectedNodes = getNodes().filter((n) => n.selected) as FlowNode[];
        copy(selectedNodes);
      },
      options: { ignoreInputs: true },
    },
    {
      hotkey: "Mod+V",
      callback: () => {
        paste(doc, screenToFlowPosition(cursorPositionRef.current));
      },
      options: { ignoreInputs: true },
    },
    {
      hotkey: "Mod+A",
      callback: () => {
        setNodes(getNodes().map((node) => ({ ...node, selected: true })));
        setEdges(getEdges().map((edge) => ({ ...edge, selected: true })));
      },
      options: { ignoreInputs: true },
    },
    {
      hotkey: "Mod+Z",
      callback: history.undo,
      options: { ignoreInputs: true },
    },
    {
      hotkey: "Mod+Shift+Z",
      callback: history.redo,
      options: { ignoreInputs: true },
    },
    {
      hotkey: "Shift+1",
      callback: () => {
        const selectedNodes = nodes.filter((node) => node.selected);
        fitView({
          nodes: selectedNodes.length ? selectedNodes : nodes,
          padding: 0.25,
          duration: 250,
        });
      },
      options: { ignoreInputs: true },
    },
  ]);

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
