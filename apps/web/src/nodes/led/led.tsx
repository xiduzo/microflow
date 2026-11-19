import { isPmwPin, pinsToOptions } from "@/board/pin-label";
import { MODES, usePins } from "@/board/board-store";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { NodeHandles } from "../_base/node-handles";
import { dataSchema, defaults, type Data, type Value } from "./led.schema";
import { useNodeValue } from "@/nodes/live/node-data";
import { LightbulbIcon, LightbulbOffIcon, VibrateIcon } from "lucide-react";

export function Led(props: Props) {
  const pins = usePins([MODES.PWM]);

  const isPmw = isPmwPin(props.data.pin, pins);

  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      {/* Whether `value` can be driven depends on the connected board's pin,
          not on the node's settings, so it is said here and not in the rule. */}
      <NodeHandles<"Led">
        portOverrides={{
          value: { hint: isPmw ? "0-255" : "requires a ~ pin", isConnectable: !!isPmw },
        }}
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
