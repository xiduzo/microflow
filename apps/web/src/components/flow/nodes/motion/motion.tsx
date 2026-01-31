import { useNodeValue } from "@/stores/node-data";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { EyeClosedIcon, EyeIcon } from "lucide-react";
import { MODES, usePins } from "@/stores/board";
import { reducePinsToOptions } from "@/components/hardware/pin";
import { MOTION_CONTROLLERS } from "./motion.constants";
import { dataSchema, type Data, type Value } from "./motion.schema";

export function Motion(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="source" position="right" id="motionstart" title="Started motion" offset={-1} />
      <Handle type="source" position="right" id="change" />
      <Handle type="source" position="right" id="motionend" title="Ended motion" offset={1} />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(false);

  if (!value) return <EyeClosedIcon className="text-muted-foreground" size={48} />;
  return <EyeIcon className="text-green-500" size={48} />;
}

function Settings() {
  const data = useNodeData<Data>();
  const pins = usePins(
    data.controller === "HCSR501" ? [MODES.INPUT] : [MODES.INPUT, MODES.ANALOG],
    data.controller === "HCSR501" ? [MODES.I2C, MODES.ANALOG] : [MODES.I2C],
  );
  const { render } = useNodeControls(
    {
      pin: { value: data.pin, options: pins.reduce(reducePinsToOptions, {}) },
      controller: { value: data.controller, options: MOTION_CONTROLLERS },
    },
    [pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Motion.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "sense",
    tags: ["trigger", "source"],
    icon: "EyeIcon",
    label: "Motion",
    description: "Detect when something moves nearby, like a person walking past",
  } satisfies Props["data"],
};
