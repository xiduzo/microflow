import { useNodeValue } from "@/stores/node-data";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { dataSchema, defaults, type Data, type Value } from "./proximity.schema";
import { MODES, usePins } from "@/stores/board";
import { pinsToOptions } from "@/components/hardware/pin";
import { PROXIMITY_CONTROLLERS } from "./proximity.constants";

export function Proximity(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="source" position="right" id="value" handleType="value" />
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
      options: pinsToOptions(pins),
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
Proximity.defaultProps = { data: defaults };
