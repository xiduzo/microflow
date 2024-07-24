import { useMqtt } from "@fhb/mqtt/client";
import { Input, Label } from "@fhb/ui";
import { Position } from "@xyflow/react";
import { useEffect } from "react";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function Mqtt(props: Props) {
  const { updateNodeData } = useUpdateNodeData<MqttData>(props.id);

  const { publish } = useMqtt()

  useEffect(() => {
    console.log(props.data.value)
  }, [props.data.value])

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="text tabular-nums">
          {JSON.stringify(props.data.value)}
        </NodeHeader>
        <Label
          htmlFor={`mqtt-${props.id}`}
          className="flex justify-between"
        >
          Topic
        </Label>
        <Input id={`mqtt-${props.id}`} placeholder="your/+/topic/#" onChange={event => updateNodeData({
          topic: event.target.value,
        })} />
      </NodeContent>
      <Handle type="target" position={Position.Top} id="set" />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type MqttData = { topic?: string };
type Props = AnimatedNode<MqttData, unknown>;
