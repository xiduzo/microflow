import { folder } from "leva";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { Handle } from "../../handle";
import { useNodeValue } from "@/stores/node-data";
import { type Value, type Data, dataSchema } from "./sensor.schema";
import { Switch } from "@/components/ui/switch";
import {
  BicepsFlexedIcon,
  CircleArrowOutUpLeftIcon,
  MagnetIcon,
  MoveUpIcon,
  SunDimIcon,
  SunIcon,
  SunMediumIcon,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cva, type VariantProps } from "class-variance-authority";
import { MODES, usePins } from "@/stores/board";
import { reducePinsToOptions } from "@/components/hardware/pin";

export function Sensor(props: Props) {
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
  const data = useNodeData<Data>();

  const progress = Math.round((value / 1023) * 100);

  if (data.type === "digital") {
    return <Switch checked={Boolean(value)} className="scale-150" />;
  }

  switch (data.subType) {
    case "ldr":
      if (progress <= 33) return <SunDimIcon className={`text-yellow-500/30`} size={48} />;
      if (progress <= 66) return <SunMediumIcon className={`text-yellow-500/60`} size={48} />;
      if (progress > 66) return <SunIcon className={`text-yellow-500`} size={48} />;
      break;
    case "force":
      return <BicepsFlexedIcon size={48} style={{ transform: `scale(${1 + progress / 100})` }} />;
    case "potentiometer":
      return (
        <CircleArrowOutUpLeftIcon
          size={48}
          style={{
            transform: `rotate(${progress * 2.7 - 90}deg)`,
          }}
        />
      );
    case "tilt":
      return (
        <MoveUpIcon
          size={48}
          style={{
            transform: `rotate(${progress < 50 ? 180 : 0}deg)`,
          }}
        />
      );
    case "hall-effect":
      return (
        <MagnetIcon
          size={48}
          className={hallEffect({
            polarity: (Math.round(progress / 10) * 10) as HallEffectProps["polarity"],
          })}
          style={{
            transform: `rotate(${progress * (360 / 100 / 2) + 135}deg)`,
          }}
        />
      );
    default:
      return (
        <Progress
          min={0}
          max={100}
          value={progress}
          className="border border-muted-foreground mx-12 w-full"
        />
      );
  }
}

type HallEffectProps = VariantProps<typeof hallEffect>;
const hallEffect = cva("", {
  variants: {
    polarity: {
      0: "text-red-600",
      10: "text-red-500",
      20: "text-red-400",
      30: "text-red-300",
      40: "text-red-200",
      50: "text-gray-200",
      60: "text-blue-200",
      70: "text-blue-300",
      80: "text-blue-400",
      90: "text-blue-500",
      100: "text-blue-600",
    },
  },
});

function Settings() {
  const data = useNodeData<Data & { subType?: string }>();
  const pins = usePins([MODES.INPUT, MODES.ANALOG]);
  
  // Convert string pin values (like "A0") to actual pin numbers for Leva
  // Leva options store numeric pin values, so we need to match that format
  let pinValue: number | string = data.pin;
  if (typeof data.pin === "string" && pins.length > 0) {
    const match = data.pin.match(/^A(\d+)$/i);
    if (match) {
      const analogIndex = parseInt(match[1], 10);
      const analogPins = pins.filter((p) => p.supportedModes.includes(MODES.ANALOG) && p.analogChannel >= 0);
      const base = analogPins.length > 0 ? Math.min(...analogPins.map((p) => p.analogChannel)) : 0;
      const targetChannel = base + analogIndex;
      const foundPin = pins.find((p) => p.analogChannel === targetChannel);
      if (foundPin) {
        pinValue = foundPin.pin;
      }
    }
  }
  
  const { render, setNodeData } = useNodeControls(
    {
      pin: { 
        value: pinValue, 
        options: pins.reduce(reducePinsToOptions, {}),
      },
      advanced: folder(
        {
          threshold: { min: 0, step: 1, value: data.threshold! },
          freq: { min: 10, step: 1, value: data.freq! },
        },
        {
          collapsed: true,
        },
      ),
    },
    [pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Sensor.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "hardware",
    tags: ["input", "analog"],
    label: "Analog Sensor",
    icon: "GaugeIcon",
    description:
      "Measure values that change smoothly, like temperature, pressure, or how bright something is",
  } satisfies Props["data"],
};

export const DigitalSensor = (props: Props) => <Sensor {...props} />;
DigitalSensor.defaultProps = {
  data: {
    ...Sensor.defaultProps.data,
    label: "Digital Sensor",
    tags: ["input", "digital"],
    type: "digital",
    icon: "PowerIcon",
    description: "Detect when something is on or off, like a switch or motion detector",
  } satisfies Props["data"],
};

export const Tilt = (props: Props) => <Sensor {...props} />;
Tilt.defaultProps = {
  data: {
    ...Sensor.defaultProps.data,
    label: "Tilt",
    tags: ["input", "analog", "digital"],
    subType: "tilt",
    icon: "MoveUpIcon",
    threshold: 10,
    description: "Detect when an object is tilted or rotated from its normal position",
  } satisfies Props["data"],
};

export const Ldr = (props: Props) => <Sensor {...props} />;
Ldr.defaultProps = {
  data: {
    ...Sensor.defaultProps.data,
    label: "Light Dependent Resistor (LDR)",
    tags: ["input", "analog"],
    subType: "ldr",
    icon: "SunIcon",
    description: "Measure how bright or dark the surrounding environment is",
  } satisfies Props["data"],
};

export const Potentiometer = (props: Props) => <Sensor {...props} />;
Potentiometer.defaultProps = {
  data: {
    ...Sensor.defaultProps.data,
    label: "Potentiometer",
    tags: ["input", "analog"],
    subType: "potentiometer",
    icon: "CircleArrowOutUpLeftIcon",
    description: "Read values from a knob or slider that you can turn or move to control something",
  } satisfies Props["data"],
};

export const Force = (props: Props) => <Sensor {...props} />;
Force.defaultProps = {
  data: {
    ...Sensor.defaultProps.data,
    label: "Force",
    tags: ["input", "analog"],
    subType: "force",
    icon: "BicepsFlexedIcon",
    description: "Measure how much pressure or force is being applied to a surface",
  } satisfies Props["data"],
};

export const HallEffect = (props: Props) => <Sensor {...props} />;
HallEffect.defaultProps = {
  data: {
    ...Sensor.defaultProps.data,
    label: "Hall Effect",
    tags: ["input", "analog"],
    subType: "hall-effect",
    icon: "MagnetIcon",
    description: "Detect when a magnet or magnetic object is nearby and how strong it is",
  } satisfies Props["data"],
};
