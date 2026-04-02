import { dataSchema, type Data } from "./mqtt.schema";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { RadioIcon, RadioTowerIcon } from "lucide-react";
import { IconWithValue } from "../../icon-with-value";
import { useMqttBrokerStore } from "@/stores/mqtt-broker";
import { useMemo } from "react";

export function Mqtt(props: Props) {
  const brokers = useMqttBrokerStore((s) => s.brokers);
  const hasBrokers = brokers.length > 0;
  const broker = brokers.find((b) => b.id === props.data.brokerId);
  const error = !hasBrokers
    ? "No MQTT brokers configured"
    : !broker
      ? "Select a broker"
      : undefined;

  return (
    <NodeContainer {...props} error={error}>
      <Value />
      <Settings />
      {props.data.direction === "publish" && <Handle type="target" position="left" id="trigger" handleType="command" />}
      {props.data.direction === "subscribe" && (
        <Handle type="source" position="right" id="value" handleType="value" />
      )}
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const brokers = useMqttBrokerStore((s) => s.brokers);
  const broker = brokers.find((b) => b.id === data.brokerId);

  const displayValue = useMemo(() => {
    if (!broker) return "No broker";
    if (!data.topic) return broker.name;
    return `${broker.name}: ${data.topic}`;
  }, [broker, data.topic]);

  return (
    <IconWithValue
      icon={data.direction === "publish" ? RadioTowerIcon : RadioIcon}
      value={displayValue}
    />
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const brokers = useMqttBrokerStore((s) => s.brokers);

  const brokerOptions = useMemo(() => {
    const options: Record<string, string> = { "Select broker...": "" };
    for (const broker of brokers) {
      const label = broker.name + (broker.isDefault ? " (default)" : "");
      options[label] = broker.id;
    }
    return options;
  }, [brokers]);

  const { render } = useNodeControls(
    {
      brokerId: {
        value: data.brokerId,
        options: brokerOptions,
        label: "Broker",
      },
      direction: {
        value: data.direction,
        options: ["publish", "subscribe"],
      },
      topic: { value: data.topic },
      qos: {
        value: data.qos,
        options: { "0": "At most once (0)", "1": "At least once (1)", "2": "Exactly once (2)" },
        label: "QoS",
      },
      ...(data.direction === "publish" && {
        retain: { value: data.retain },
      }),
    },
    [brokers, data.direction]
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Mqtt.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "sense",
    tags: ["value", "source", "action", "external"],
    label: "MQTT",
    icon: "RadioTowerIcon",
    description: "Send and receive real-time messages over a network using MQTT — great for IoT and smart home setups",
  } satisfies Props["data"],
};
