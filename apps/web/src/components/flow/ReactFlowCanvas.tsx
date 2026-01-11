import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import { useReactFlowCanvas } from "@/stores/react-flow";

import "@xyflow/react/dist/style.css";
import { NODE_TYPES } from "./nodes/_TYPES";
import { NewNodeDialog } from "./dialogs/new-node-dialog";
import { SettingsPanel } from "./panels/settings-panel";
import { useCallback, useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { EDGE_TYPES } from "./edges/edges.constants";

export function ReactFlowCanvas() {
  const { fitView } = useReactFlow();

  const store = useReactFlowCanvas();

  const zoomToFit = useCallback(() => {
    fitView({ duration: 250, padding: 0.15, maxZoom: 1 });
  }, [fitView]);

  useEffect(zoomToFit, [zoomToFit]);

  useHotkeys(
    ["ctrl+z", "meta+z"],
    () => {
      console.log("undo");
    },
    {
      enabled: true,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    }
  );

  useHotkeys(
    ["ctrl+shift+z", "meta+shift+z"],
    () => {
      console.log("redo");
    },
    {
      enabled: true,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    }
  );

  useHotkeys(
    ["ctrl+a", "meta+a"],
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
    ["ctrl+c", "meta+c"],
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
    ["ctrl+v", "meta+v"],
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

  useHotkeys(["ctrl+o", "meta+o"], zoomToFit, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
  });

  return (
    <ReactFlow
      {...store}
      colorMode="system"
      minZoom={0.1}
      maxZoom={2}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.2 }}
    >
      <MiniMap nodeBorderRadius={6} pannable zoomable />
      <Background gap={140} />
      <Controls />
      <NewNodeDialog />
      <Panel position="top-right">
        <SettingsPanel />
      </Panel>
    </ReactFlow>
  );
}
