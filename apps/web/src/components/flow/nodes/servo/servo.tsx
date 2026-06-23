import { CircleIcon, RotateCcwIcon, RotateCwIcon, SlashIcon } from "lucide-react";
import { Handle as BaseHandle } from "../../handle";

const Handle = BaseHandle<"Servo">;
import { NodeContainer, useDeleteHandles, useNodeControls, type BaseNode } from "../_base/_base";
import { useNodeData } from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { type Data, type Value, dataSchema, defaults } from "./servo.schema";
import { pinsToOptions } from "@/components/hardware/pin";
import { MODES, usePins } from "@/stores/board";

export function Servo(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      {props.data.type === "standard" && (
        <>
          <Handle type="target" position="left" id="min" handleType="value" offset={-1} />
          <Handle type="target" position="left" id="value" handleType="value" />
          <Handle type="target" position="left" id="max" handleType="value" offset={1} />
        </>
      )}
      {props.data.type === "continuous" && (
        <>
          <Handle type="target" position="left" id="value" handleType="value" hint="from -1 to 1" offset={-0.5} />
          <Handle type="target" position="left" id="stop" handleType="command" offset={0.5} />
        </>
      )}
      <Handle type="source" position="right" id="value" handleType="value" />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(data.range.min);

  if (data.type === "continuous") {
    if (!value) return <CircleIcon className="text-muted-foreground" size={48} />;
    if (value > 0) return <RotateCcwIcon className="animate-spin direction-reverse" size={48} />;
    return <RotateCwIcon className="animate-spin" size={48} />;
  }

  return (
    <section className="relative">
      <section
        className="origin-bottom absolute transition-all"
        style={{ rotate: `${data.range.min - 90}deg` }}
      >
        <SlashIcon className="-rotate-45 dark:text-red-500/20 text-red-500/30" size={48} />
      </section>
      <section
        className="origin-bottom absolute transition-all"
        style={{ rotate: `${data.range.max - 90}deg` }}
      >
        <SlashIcon className="-rotate-45 dark:text-green-500/20 text-green-500/30" size={48} />
      </section>
      <section className="origin-bottom transition-all" style={{ rotate: `${value - 90}deg` }}>
        <SlashIcon className="-rotate-45 text-muted-foreground" size={48} />
      </section>
      <div className="absolute w-4 h-4 left-4 -bottom-2 rounded-full bg-muted-foreground" />
    </section>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const deleteHandles = useDeleteHandles();
  const pins = usePins([MODES.OUTPUT, MODES.PWM]);

  const { render } = useNodeControls(
    {
      pin: { value: data.pin, options: pinsToOptions(pins) },
      type: {
        value: data.type,
        options: ["standard", "continuous"],
        transient: false,
        onChange: (event) =>
          deleteHandles(event === "standard" ? ["value", "stop"] : ["min", "value", "max"]),
      },
      range: {
        value: data.range,
        step: 1,
        min: 0,
        max: 180,
        render: (get) => get("type") === "standard",
        joystick: false,
      },
    },
    [pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Servo.defaultProps = { data: defaults };
