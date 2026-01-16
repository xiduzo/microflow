import { useNodeValue } from "@/stores/node-data";
import { Handle } from "../../handle";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base";
import { RgbaColorPicker } from "react-colorful";
import { MODES, usePins } from "@/stores/board";
import { reducePinsToOptions } from "@/components/hardware/pin";
import { dataSchema, type Data, type Value } from "./rgb.schema";
import { PaletteIcon } from "lucide-react";
import { folder } from "leva";

export function Rgb(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle
        type="target"
        position="left"
        id="red"
        hint="0-255"
        offset={-1.5}
      />
      <Handle
        type="target"
        position="left"
        id="green"
        hint="0-255"
        offset={-0.5}
      />
      <Handle
        type="target"
        position="left"
        id="blue"
        hint="0-255"
        offset={0.5}
      />
      <Handle
        type="target"
        position="left"
        id="alpha"
        hint="0-100"
        offset={1.5}
      />
      <Handle type="source" position="right" id="change" />
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
          options: pins.reduce(reducePinsToOptions, {}),
          onChange: (value) => {
            setNodeData({
              pins: { red: value, green: data.pins.green, blue: data.pins.blue },
            });
          },
        },
        green: {
          value: Array.isArray(data.pins) ? data.pins[1] : data.pins.green,
          options: pins.reduce(reducePinsToOptions, {}),
          onChange: (value) => {
            setNodeData({
              pins: { red: data.pins.red, green: value, blue: data.pins.blue },
            });
          },
        },
        blue: {
          value: Array.isArray(data.pins) ? data.pins[2] : data.pins.blue,
          options: pins.reduce(reducePinsToOptions, {}),
          onChange: (value) => {
            setNodeData({
              pins: { red: data.pins.red, green: data.pins.green, blue: value },
            });
          },
        },
      }),
      isAnode: { value: Boolean(data.isAnode), label: "anode" },
    },
    [pins, data.pins]
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Rgb.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "hardware",
    tags: ["output", "analog"],
    label: "RGB",
    icon: "PaletteIcon",
    description:
      "Control a colored light that can display any color by mixing red, green, and blue",
  } satisfies Props["data"],
};
