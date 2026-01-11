import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type ColorMode,
} from "@xyflow/react";
import { useReactFlowCanvas } from "@/stores/react-flow";

import "@xyflow/react/dist/style.css";
import { NODE_TYPES } from "./nodes/_TYPES";
import { NewNodeDialog } from "./dialogs/new-node-dialog";
import { SettingsPanel } from "./panels/settings-panel";
import { useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { EDGE_TYPES } from "./edges/edges.constants";
import { DockPanel } from "./panels/dock-panel";
import { useTheme } from "@/providers/theme-provider";
import { HotkeySheet } from "./sheets/hotkey-sheet";

export function ReactFlowCanvas() {
  const { fitView } = useReactFlow();
  const { theme } = useTheme();

  const store = useReactFlowCanvas();

  useEffect(() => {
    fitView();
  }, [fitView]);

  useHotkeys(
    "meta+a",
    () => {
      console.log("select all");
    },
    {
      enabled: true,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    }
  );

  useHotkeys(
    "meta+c",
    () => {
      console.log("copy");
    },
    {
      enabled: true,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    }
  );

  useHotkeys(
    "meta+v",
    () => {
      console.log("paste");
    },
    {
      enabled: true,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    }
  );

  return (
    <ReactFlow
      {...store}
      colorMode={(theme as ColorMode) ?? "system"}
      minZoom={0.1}
      maxZoom={2}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      fitView
      selectNodesOnDrag={false}
      fitViewOptions={{ padding: 0.15 }}
    >
      <MiniMap nodeBorderRadius={6} pannable zoomable />
      <Background gap={140} />
      <Controls />
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
