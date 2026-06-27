import { isPmwPin, pinsToOptions } from "@/components/hardware/pin";
import { MODES, usePins } from "@/stores/board";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { NodeHandles } from "../_base/node-handles";
import { dataSchema, defaults, type Data, type Value } from "./led.schema";
import { useNodeValue } from "@/stores/node-data";
import { LightbulbIcon, LightbulbOffIcon, VibrateIcon } from "lucide-react";

export function Led(props: Props) {
  const pins = usePins([MODES.PWM]);

  const isPmw = isPmwPin(props.data.pin, pins);

  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles
        instance="Led"
        portOverrides={{
          true: { handleType: "command", offset: -1.5 },
          toggle: { handleType: "command", offset: -0.5 },
          value: {
            handleType: "value",
            title: props.data.subType === "vibration" ? "intensity" : "brightness",
            offset: 0.5,
            hint: `${isPmw ? "0-255" : "requires a ~ pin"}`,
            isConnectable: !!isPmw,
          },
          false: { handleType: "command", offset: 1.5 },
        }}
        emitOverrides={{ value: { handleType: "value" } }}
      />
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
      pin: { value: data.pin, options: pinsToOptions(pins) },
    },
    [pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Led.defaultProps = { data: defaults };
