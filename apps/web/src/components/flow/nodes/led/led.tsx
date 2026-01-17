import { isPmwPin, reducePinsToOptions } from "@/components/hardware/pin";
import { MODES, usePins } from "@/stores/board";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base";
import { Handle } from "../../handle";
import { dataSchema, type Data, type Value } from "./led.schema";
import { useNodeValue } from "@/stores/node-data";
import { LightbulbIcon, LightbulbOffIcon, VibrateIcon } from "lucide-react";

export function Led(props: Props) {
  const pins = usePins([MODES.PWM]);

  const isPmw = isPmwPin(props.data.pin, pins);

  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="turnOn" title="on" offset={-1.5} />
      <Handle type="target" position="left" id="toggle" offset={-0.5} />
      <Handle
        type="target"
        position="left"
        id="brightness"
        title={props.data.subType === "vibration" ? "intensity" : "brightness"}
        offset={0.5}
        hint={`${isPmw ? "0-255" : "requires a ~ pin"}`}
        isConnectable={!!isPmw}
      />
      <Handle type="target" position="left" id="turnOff" title="off" offset={1.5} />
      <Handle type="source" position="right" id="change" />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(0);

  switch (data.subType) {
    case "vibration":
      return <VibrationValue value={value} />;
    default:
      return <LedValue value={value} />;
  }
}

function LedValue(props: { value: number }) {
  if (!props.value) return <LightbulbOffIcon size={48} className="text-muted-foreground" />;
  return <LightbulbIcon size={48} className="text-yellow-500" />;
}

function VibrationValue(props: { value: number }) {
  if (!props.value) return <VibrateIcon className="text-muted-foreground" size={48} />;
  return (
    <section className="relative">
      <VibrateIcon
        className="text-orange-500 animate-wiggle"
        size={48}
        style={{
          animationDuration: `${250 + (250 - (props.value > 1 ? props.value / 255 : 1) * 250)}ms`,
        }}
      />
      <div className="animate-ping w-8 h-8 bg-orange-500 rounded-full absolute left-[9px] right-0 bottom-0 top-2 -z-10"></div>
    </section>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const pins = usePins([MODES.INPUT]);

  const { render } = useNodeControls(
    {
      pin: { value: data.pin, options: pins.reduce(reducePinsToOptions, {}) },
    },
    [pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Led.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "hardware",
    tags: ["output", "analog", "digital"],
    label: "LED",
    icon: "LightbulbIcon",
    description: "Turn a light on or off, or control its brightness",
  } satisfies Props["data"],
};

export const Vibration = (props: Props) => <Led {...props} />;
Vibration.defaultProps = {
  data: {
    ...Led.defaultProps.data,
    label: "Vibration",
    tags: ["output", "analog", "digital"],
    subType: "vibration",
    icon: "VibrateIcon",
    description: "Make a device vibrate with different intensities",
  } satisfies Props["data"],
};
