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
    if (!props.data.topic.length) return

    publish(props.data.topic, JSON.stringify(props.data.value))

  }, [props.data.value, props.data.topic, publish])

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="tabular-nums">
          {JSON.stringify(props.data.value)}
        </NodeHeader>
        <Label
          htmlFor={`mqtt-${props.id}`}
          className="flex justify-between"
        >
          Topic
        </Label>
        <Input id={`mqtt-${props.id}`} defaultValue={props.data.topic} placeholder="your/+/topic/#" onChange={event => updateNodeData({
          topic: event.target.value,
        })} />
      </NodeContent>
      <Handle type="target" position={Position.Top} id="send" />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type MqttData = { topic?: string };
type Props = AnimatedNode<MqttData, unknown>;
