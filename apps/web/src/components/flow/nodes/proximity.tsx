import { useNodeValue } from "@/stores/node-data";
import { Handle } from "../handle";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "./_base";
import {
  dataSchema,
  type Data,
  type Value,
} from "@microflow/runtime/proximity/proximity.types";
import { MODES, usePins } from "@/stores/board";
import { reducePinsToOptions } from "@/components/hardware/pin";
import { PROXIMITY_CONTROLLERS } from "@microflow/runtime/proximity/proximity.constants";
import { TargetIcon } from "lucide-react";

export function Proximity(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="source" position="right" id="change" />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(0);

  return <div>{value}</div>;
}

function Settings() {
  const data = useNodeData<Data>();
  const pins = usePins([MODES.INPUT, MODES.ANALOG]);

  const { render } = useNodeControls({
    pin: {
      value: data.pin,
      options: pins.reduce(reducePinsToOptions, {}),
    },
    controller: {
      value: data.controller,
      options: PROXIMITY_CONTROLLERS,
    },
    freq: { value: data.freq!, min: 10, label: "frequency (ms)" },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Proximity.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "hardware",
    tags: ["input", "analog"],
    label: "Proximity",
    icon: TargetIcon,
    description: "Measure how far away an object is from the sensor",
  } satisfies Props["data"],
};

// GP2Y0A21YK, GP2D120XJ00F, GP2Y0A02YK0F, GP2Y0A41SK0F, GP2Y0A710K0F, PING_PULSEIN *, MB1000, MB1003, MB1230, LIDARLITE. See aliases
