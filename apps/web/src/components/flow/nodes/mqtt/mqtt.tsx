import { dataSchema, type Data, type Value } from "./mqtt.schema";
import { Handle } from "../../handle";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base";
import { useNodeValue } from "@/stores/node-data";
import { RadioIcon, RadioTowerIcon } from "lucide-react";
import { IconWithValue } from "../../icon-with-value";

export function Mqtt(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      {props.data.direction === "publish" && (
        <Handle type="target" position="left" id="publish" />
      )}
      {props.data.direction === "subscribe" && (
        <Handle type="source" position="right" id="message" />
      )}
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>("");

  return (
    <IconWithValue
      icon={data.direction === "publish" ? RadioTowerIcon : RadioIcon}
      value={data.topic || "No topic set"}
    />
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    direction: {
      value: data.direction,
      options: ["publish", "subscribe"],
    },
    topic: { value: data.topic },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Mqtt.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "external",
    tags: ["input", "output"],
    label: "MQTT",
    icon: RadioTowerIcon,
    description: "Send and receive messages over the network using MQTT protocol",
  } satisfies Props["data"],
};
