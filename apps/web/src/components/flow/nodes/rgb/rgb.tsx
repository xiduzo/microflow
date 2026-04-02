import { useNodeValue } from "@/stores/node-data";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { RgbaColorPicker } from "react-colorful";
import { MODES, usePins } from "@/stores/board";
import { pinsToOptions } from "@/components/hardware/pin";
import { dataSchema, type Data, type Value } from "./rgb.schema";
import { folder } from "leva";

export function Rgb(props: Props) {
  return (
    <NodeContainer {...props} className="min-w-sm">
      <Value />
      <Settings />
      <Handle type="target" position="left" id="red" handleType="value" hint="0-255" offset={-1.5} />
      <Handle type="target" position="left" id="green" handleType="value" hint="0-255" offset={-0.5} />
      <Handle type="target" position="left" id="blue" handleType="value" hint="0-255" offset={0.5} />
      <Handle type="target" position="left" id="alpha" handleType="value" hint="0-100" offset={1.5} />
      <Handle type="source" position="right" id="event" handleType="event" />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>({ r: 0, g: 0, b: 0, a: 1 });

  return (
    <section className="px-10">
      <RgbaColorPicker color={value} />
    </section>
  );
}

function Settings() {
  const pins = usePins([MODES.OUTPUT, MODES.PWM]);
  const data = useNodeData<Data>();
  const { render, setNodeData } = useNodeControls(
    {
      pins: folder({
        red: {
          value: Array.isArray(data.pins) ? data.pins[0] : data.pins.red,
          options: pinsToOptions(pins),
          onChange: (value) => {
            setNodeData({
              pins: { red: value, green: data.pins.green, blue: data.pins.blue },
            });
          },
        },
        green: {
          value: Array.isArray(data.pins) ? data.pins[1] : data.pins.green,
          options: pinsToOptions(pins),
          onChange: (value) => {
            setNodeData({
              pins: { red: data.pins.red, green: value, blue: data.pins.blue },
            });
          },
        },
        blue: {
          value: Array.isArray(data.pins) ? data.pins[2] : data.pins.blue,
          options: pinsToOptions(pins),
          onChange: (value) => {
            setNodeData({
              pins: { red: data.pins.red, green: data.pins.green, blue: value },
            });
          },
        },
      }),
      isAnode: { value: Boolean(data.isAnode), label: "anode" },
    },
    [pins, data.pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Rgb.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "express",
    tags: ["action"],
    label: "RGB",
    icon: "PaletteIcon",
    description: "Control an RGB LED to show any color by mixing red, green, and blue channels",
  } satisfies Props["data"],
};
