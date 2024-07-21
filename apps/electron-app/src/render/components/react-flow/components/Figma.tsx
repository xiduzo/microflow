import { FigmaVariable, useFigmaVariable, useMqtt } from "@fhb/mqtt/client";
import {
  Icons,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@fhb/ui";
import { Position, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCodeUploader } from "../../../hooks/codeUploader";
import { nodeSelector, useNodesEdgesStore } from "../../../store";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function Figma(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<Props["data"]>(props.id)),
  );
  const updateNodeInternals = useUpdateNodeInternals();

  const uploadCode = useCodeUploader();
  const { status, publish, appName } = useMqtt();

  const { updateNodeData } = useReactFlow();

  const { variables, variable, value } = useFigmaVariable(
    node?.data?.variableId,
  );

  function handleNodeUpdate(data: Partial<Props["data"]>) {
    updateNodeData(props.id, data);
    uploadCode();
  }

  useEffect(() => {
    window.electron.ipcRenderer.send(
      "ipc-fhb-value-changed",
      props.type,
      node.id,
      value,
    );
  }, [value, node.id, props.type]);

  useEffect(() => {
    if (status !== "connected") return;
    if (node?.data?.value === undefined) return;
    if (!variable) return;

    publish(
      `fhb/v1/xiduzo/${appName}/variable/${variable.id}/set`,
      JSON.stringify(node.data.value),
    );
  }, [node?.data?.value, variable, publish, status, appName]);

  useEffect(() => {
    if (!variable?.resolvedType) return;

    updateNodeInternals(node.id);
  }, [variable?.resolvedType, node.id]);

  if (!node) return null;

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader>
          <FigmaHeaderContent
            variable={variable}
            hasVariables={!!Array.from(Object.values(variables)).length}
            value={node.data.value ?? value}
          />
        </NodeHeader>
        <Select
          disabled={!Array.from(Object.values(variables)).length}
          value={node.data.variableId}
          onValueChange={(value) => handleNodeUpdate({ variableId: value })}
        >
          <SelectTrigger>{variable?.name ?? "Select variable"}</SelectTrigger>
          <SelectContent>
            {Array.from(Object.values(variables)).map(
              (variable: FigmaVariable) => (
                <SelectItem key={variable.id} value={variable.id}>
                  {variable.name}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </NodeContent>
      {variable?.resolvedType === "BOOLEAN" && (
        <>
          <Handle type="target" position={Position.Top} id="true" offset={-1} />
          <Handle type="target" position={Position.Top} id="toggle" />
          <Handle type="target" position={Position.Top} id="false" offset={1} />
        </>
      )}
      {variable?.resolvedType === "COLOR" && (
        <>
          <Handle
            type="target"
            position={Position.Top}
            id="red"
            hint="0-255"
            offset={-1.5}
          />
          <Handle
            type="target"
            position={Position.Top}
            id="green"
            hint="0-255"
            offset={-0.5}
          />
          <Handle
            type="target"
            position={Position.Top}
            id="blue"
            hint="0-255"
            offset={0.5}
          />
          <Handle
            type="target"
            position={Position.Top}
            id="opacity"
            hint="0-100"
            offset={1.5}
          />
        </>
      )}
      {variable?.resolvedType === "FLOAT" && (
        <>
          <Handle
            type="target"
            position={Position.Top}
            id="increment"
            offset={-0.5}
          />
          <Handle
            type="target"
            position={Position.Top}
            id="decrement"
            offset={0.5}
          />
        </>
      )}
      <Handle type="target" position={Position.Left} id="set" />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

function FigmaHeaderContent(props: {
  variable?: FigmaVariable;
  value: unknown;
  hasVariables: boolean;
}) {
  if (!props.hasVariables) {
    return <Icons.Loader2 className="w-12 h-12 animate-spin" />;
  }

  if (!props.variable) {
    return <Icons.Variable className="w-12 h-12 opacity-40" />;
  }

  switch (props.variable.resolvedType) {
    case "BOOLEAN":
      return (
        <Switch className="scale-150" disabled checked={Boolean(props.value)} />
      );
    case "FLOAT":
      return (
        <span className="text-4xl tabular-nums">
          {Number(props.value ?? 0)}
        </span>
      );
    case "STRING":
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="-mx-8 max-w-52 max-h-20 text-wrap overflow-hidden pointer-events-auto">
                {String(props.value)}
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {String(props.value)}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    case "COLOR":
      const { r, g, b, a } = (props.value ?? { r: 0, g: 0, b: 0, a: 0 }) as {
        r: number;
        g: number;
        b: number;
        a: number;
      };
      return (
        <div
          className="w-full h-14 rounded-sm bg-green-50 border-2 border-black ring-2 ring-white"
          style={{
            backgroundColor: `rgba(${r * 255},${g * 255},${b * 255},${a * 255})`,
          }}
        ></div>
      );
    default:
      return <div>Unknown type</div>;
  }
}

type FigmaData = {
  variableId?: string;
};
type Props = AnimatedNode<FigmaData, string | number | boolean>;
