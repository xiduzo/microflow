import { dataSchema, defaults, type Data } from "./mqtt.schema";
import { NodeHandles } from "../_base/node-handles";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { RadioIcon, RadioTowerIcon } from "lucide-react";
import { IconWithValue } from "../_base/icon-with-value";
import { useMemo } from "react";
import { useBrokerBinding } from "../_base/broker-binding";

export function Mqtt(props: Props) {
  const { error } = useBrokerBinding(props.data.brokerId);

  return (
    <NodeContainer {...props} error={error}>
      <Value />
      <Settings />
      <NodeHandles />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const { broker } = useBrokerBinding(data.brokerId);

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
  const { control: brokerControl } = useBrokerBinding(data.brokerId);

  const { render } = useNodeControls(
    {
      brokerId: brokerControl,
      direction: {
        value: data.direction,
        options: ["publish", "subscribe"],
      },
      topic: { value: data.topic },
      qos: {
        value: data.qos,
        // Leva options are { [label]: value }; value side must be the "0"|"1"|"2"
        // the schema/runtime expect, not the human label.
        options: { "At most once (0)": "0", "At least once (1)": "1", "Exactly once (2)": "2" },
        label: "QoS",
      },
      ...(data.direction === "publish" && {
        retain: { value: data.retain },
      }),
    },
    // The options change with the broker list, not with the broker picked.
    [brokerControl.options, data.direction],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Mqtt.defaultProps = { data: defaults };
