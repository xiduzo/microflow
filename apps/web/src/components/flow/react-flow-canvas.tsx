import {
  Background,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  useOnSelectionChange,
  type ColorMode,
  type XYPosition,
  type Connection,
} from "@xyflow/react";
import {
  useFlowSession,
  useFlowHistory,
  useReactFlowBridge,
  useFlowAwareness,
  useRemoteDragPositions,
  usePublishDrag,
  applyRemoteDrag,
} from "@/session";
import { useClipboardStore } from "@/stores/clipboard-store";
import { useAskAiStore } from "@/stores/ask-ai";
import type { FlowEdge, FlowNode } from "@microflow/collab";

import "@xyflow/react/dist/style.css";
import { NODE_TYPES } from "./nodes/_REGISTRY";
import { NewNodeDialog } from "./dialogs/new-node-dialog";
import { SettingsPanel } from "./panels/settings-panel";
import { useEffect, useRef, useCallback, useMemo } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { createPointerFrame } from "@/lib/pointer-frame";
import { EDGE_TYPES } from "./edges/edges.constants";
import { DockPanel } from "./panels/dock-panel";
import { useTheme } from "@/providers/theme-provider";
import { HotkeySheet } from "./sheets/hotkey-sheet";
import { CollabCursors } from "./collab-cursors";
import { PressensePanel } from "./panels/pressense-panel";
import { track } from "@/lib/analytics";

const uid = () => Math.random().toString(36).substring(2, 9);

export function ReactFlowCanvas() {
  const { fitView, getNodes } = useReactFlow();
  const { theme } = useTheme();

  const { doc, readOnly, role } = useFlowSession();
  // Presence is deliberately *not* read here: `CollabCursors` and
  // `PressensePanel` subscribe to it themselves, so a remote cursor moving no
  // longer re-renders this component and everything under it.
  const { updateCursor } = useFlowAwareness();

  const {
    nodes: documentNodes,
    edges,
    onNodesChange: onDocumentNodesChange,
    onEdgesChange,
  } = useReactFlowBridge(doc, { readOnly });

  // A drag lives on awareness until it lands: peers see it move rather than
  // teleport on drop, and the document still records exactly one position.
  const remoteDrag = useRemoteDragPositions();
  const nodes = useMemo(
    () => applyRemoteDrag(documentNodes, remoteDrag),
    [documentNodes, remoteDrag],
  );
  const onNodesChange = usePublishDrag(onDocumentNodesChange);

  // Selection lives in React Flow's own store, which the Ask AI panel sits
  // outside of — mirroring the ids lets it scope its context to what the user
  // has highlighted.
  const setSelectedNodeIds = useAskAiStore((s) => s.setSelectedNodeIds);
  useOnSelectionChange({
    onChange: useCallback(
      ({ nodes: selected }: { nodes: Array<{ id: string }> }) =>
        setSelectedNodeIds(selected.map((node) => node.id)),
      [setSelectedNodeIds],
    ),
  });

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      const newEdge: FlowEdge = {
        id: uid(),
        source: connection.source!,
        sourceHandle: connection.sourceHandle ?? undefined,
        target: connection.target!,
        targetHandle: connection.targetHandle ?? undefined,
        type: "animated",
      };
      doc.addEdge(newEdge);
      const byId = new Map(getNodes().map((n) => [n.id, n.type]));
      track("edge_connected", {
        source: byId.get(newEdge.source) ?? "unknown",
        target: byId.get(newEdge.target) ?? "unknown",
      });
    },
    [doc, getNodes, readOnly],
  );

  useHelperHotkeys(nodes);

  const { screenToFlowPosition } = useReactFlow();

  // The cursor is ephemeral peer state. Only the latest position matters, and
  // converting to flow coordinates measures the container — so both are done
  // once per animation frame by the shared coalescer.
  const pointerFrame = useMemo(
    () => createPointerFrame((point) => updateCursor(screenToFlowPosition(point))),
    [updateCursor, screenToFlowPosition],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      pointerFrame.track({ x: event.clientX, y: event.clientY });
    },
    [pointerFrame],
  );

  useEffect(() => pointerFrame.cancel, [pointerFrame]);

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
        // A Viewer may pan, zoom and select, but not change the document.
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
        deleteKeyCode={readOnly ? null : undefined}
        selectNodesOnDrag={false}
        fitViewOptions={{ padding: 0.15 }}
        className="rounded-3xl relative"
      >
        <MiniMap nodeBorderRadius={6} pannable zoomable />
        <Background gap={260} size={2} />
        <NewNodeDialog />
        <HotkeySheet />
        <Panel position="top-right" className="flex items-center gap-2">
          <SettingsPanel />
        </Panel>
        <Panel position="bottom-center">
          <DockPanel />
        </Panel>
        <Panel position="top-left" className="flex items-center gap-2">
          {role === "viewer" && (
            <span className="rounded-full border bg-background/80 px-3 py-1 text-xs font-medium backdrop-blur">
              View only
            </span>
          )}
          <PressensePanel />
        </Panel>
      </ReactFlow>
      <CollabCursors />
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
