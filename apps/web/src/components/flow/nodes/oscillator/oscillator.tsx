import { useMemo } from "react";
import { Handle as BaseHandle } from "../../handle";

const Handle = BaseHandle<"Oscillator">;
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import {
  AudioWaveformIcon,
  DicesIcon,
  SquareIcon,
  TriangleIcon,
  TriangleRightIcon,
  type LucideIcon,
} from "lucide-react";
import { IconWithValue } from "../../icon-with-value";
import { dataSchema, defaults, type Data } from "./oscillator.schema";

export function Oscillator(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="start" handleType="command" offset={-1} />
      <Handle type="target" position="left" id="reset" handleType="command" />
      <Handle type="target" position="left" id="stop" handleType="command" offset={1} />
      <Handle type="source" position="right" id="value" handleType="value" />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();

  const icon = useMemo((): LucideIcon => {
    switch (data.waveform) {
      case "sinus":
        return AudioWaveformIcon;
      case "triangle":
        return TriangleIcon;
      case "sawtooth":
        return TriangleRightIcon;
      case "square":
        return SquareIcon;
      case "random":
        return DicesIcon;
      default:
        return AudioWaveformIcon;
    }
  }, [data.waveform]);

  return <IconWithValue icon={icon} value={data.period / 1000} suffix="s" />;
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    waveform: {
      value: data.waveform,
      options: ["sinus", "triangle", "sawtooth", "square", "random"],
    },
    period: {
      value: data.period,
      min: 100,
      step: 100,
      label: "period (ms)",
    },
    amplitude: { value: data.amplitude, min: 0.1 },
    phase: { value: data.phase },
    shift: { value: data.shift },
    autoStart: { value: data.autoStart ?? true, label: "auto start" },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Oscillator.defaultProps = { data: defaults };
