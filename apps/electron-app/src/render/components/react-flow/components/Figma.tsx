import { FigmaVariable, useFigma } from "@fhb/mqtt/client";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@fhb/ui";
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

  console.log({ id: node.data.variableId, variableValues, variableValue });

  useEffect(() => {
    console.log({ variableValue });
  }, [variableValue]);

  if (!node) return null;

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="text-4xl">
          {variableValue !== undefined ? `${variableValue}` : ""}
        </NodeHeader>
        <Select
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

type FigmaData = {
  variableId?: string;
};
type Props = AnimatedNode<FigmaData, string | number | boolean>;
