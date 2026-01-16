import {
  Background,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type ColorMode,
  type XYPosition,
} from "@xyflow/react";
import {
  useReactFlowCanvas,
  useReactFlowStoreHelpers,
} from "@/stores/react-flow";

import "@xyflow/react/dist/style.css";
import { NODE_TYPES } from "./nodes/_TYPES";
import { NewNodeDialog } from "./dialogs/new-node-dialog";
import { SettingsPanel } from "./panels/settings-panel";
import { useEffect, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { EDGE_TYPES } from "./edges/edges.constants";
import { DockPanel } from "./panels/dock-panel";
import { useTheme } from "@/providers/theme-provider";
import { HotkeySheet } from "./sheets/hotkey-sheet";

export function ReactFlowCanvas() {
  const { fitView } = useReactFlow();
  const { theme } = useTheme();
  useHelperHotkeys();

  const store = useReactFlowCanvas();

  useEffect(() => {
    fitView();
  }, [fitView]);

  return (
    <ReactFlow
      {...store}
      colorMode={(theme as ColorMode) ?? "system"}
      minZoom={0.05}
      maxZoom={3}
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
    </ReactFlow>
  );
}

function useHelperHotkeys() {
  const cursorPositionRef = useRef<XYPosition>({ x: 0, y: 0 });

  const { fitView, screenToFlowPosition } = useReactFlow();

  const helpers = useReactFlowStoreHelpers();
  const { nodes } = useReactFlowCanvas();

  useHotkeys("meta+c", helpers.copy, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
  });

  useHotkeys(
    "meta+v",
    () => {
      helpers.paste(screenToFlowPosition(cursorPositionRef.current));
    },
    {
      enabled: true,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    }
  );

  useHotkeys("meta+a", helpers.selectAll, {
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
