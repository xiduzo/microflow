import { Handle } from "../../handle";
import { IconWithValue } from "../../icon-with-value";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { dataSchema, type Data, type MovingAverage, type SmoothAverage } from "./smooth.schema";
import { EraserIcon, HighlighterIcon } from "lucide-react";

export function Smooth(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="signal" />
      <Handle type="source" position="right" id="change" />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();

  return (
    <IconWithValue
      icon={data.type === "movingAverage" ? HighlighterIcon : EraserIcon}
      value={data.type === "movingAverage" ? data.windowSize : data.attenuation}
    />
  );
}

function Settings() {
  const data = useNodeData<Data>();

  const { render } = useNodeControls({
    type: {
      value: data.type,
      options: { smooth: "smooth", "moving average": "movingAverage" },
    },
    windowSize: {
      value: (data as MovingAverage).windowSize ?? 25,
      min: 1,
      step: 1,
      render: (get) => get("type") === "movingAverage",
    },
    attenuation: {
      value: (data as SmoothAverage).attenuation ?? 0.995,
      min: 0.0,
      max: 1.0,
      step: 0.001,
      render: (get) => get("type") === "smooth",
    },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Smooth.defaultProps = {
  data: {
    ...dataSchema.parse({ type: "smooth" }),
    group: "flow",
    tags: ["transformation"],
    label: "Smooth",
    icon: "EraserIcon",
    description: "Make jumpy or noisy sensor readings smoother and more stable",
  } satisfies Props["data"],
};
