import { FigmaVariable, useFigma } from "@fhb/mqtt/client";
import {
  Icons,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Switch,
} from "@fhb/ui";
import { Position, useReactFlow } from "@xyflow/react";
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

  const uploadCode = useCodeUploader();

  const { updateNodeData } = useReactFlow();

  const { variableTypes, variableValues } = useFigma();

  function handleNodeUpdate(data: Partial<Props["data"]>) {
    updateNodeData(props.id, data);
    uploadCode();
  }

  const variable = variableTypes[node.data.variableId];

  const variableValue = variableValues[node.data.variableId];

  useEffect(() => {
    window.electron.ipcRenderer.send(
      "ipc-fhb-value-changed",
      props.type,
      node.id,
      variableValue,
    );
  }, [variableValue, node.id, props.type]);

  if (!node) return null;

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="text-4xl">
          <FigmaHeaderContent variable={variable} value={variableValue} />
        </NodeHeader>
        <Select
          disabled={!Object.values(variableTypes).length}
          value={node.data.variableId}
          onValueChange={(value) => handleNodeUpdate({ variableId: value })}
        >
          <SelectTrigger>{variable?.name ?? "Select variable"}</SelectTrigger>
          <SelectContent>
            {Array.from(Object.values(variableTypes)).map(
              (variable: FigmaVariable) => (
                <SelectItem key={variable.id} value={variable.id}>
                  {variable.name}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </NodeContent>
      <Handle type="target" position={Position.Top} id="set" />

      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

function FigmaHeaderContent(props: {
  variable?: FigmaVariable;
  value: unknown;
}) {
  if (!props.variable || props.value === undefined || props.value === null) {
    return <Icons.Loader2 className="w-12 h-12 animate-spin" />;
  }

  switch (props.variable.resolvedType) {
    case "BOOLEAN":
      return (
        <Switch className="scale-150" disabled checked={Boolean(props.value)} />
      );
    case "FLOAT":
      return (
        <span className="text-4xl tabular-nums">{Number(props.value)}</span>
      );
    case "STRING":
      return <span>{String(props.value)}</span>;
    case "COLOR":
      const { r, g, b, a } = props.value as {
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
