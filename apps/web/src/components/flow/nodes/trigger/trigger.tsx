import { folder } from "leva";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { IconWithValue } from "../../icon-with-value";
import { useNodeValue } from "@/stores/node-data";
import { dataSchema, type Data, type Value } from "./trigger.schema";
import { TrendingUpIcon } from "lucide-react";
import { TrendingDownIcon } from "lucide-react";

export function Trigger(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="signal" />
      <Handle type="source" position="right" id="bang" />
    </NodeContainer>
  );
}

const formatter = new Intl.NumberFormat("en-US");
function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(false);

  return (
    <IconWithValue
      icon={data.behaviour === "increasing" ? TrendingUpIcon : TrendingDownIcon}
      iconClassName={value ? "text-green-500" : "text-red-500"}
      value={`by ${formatter.format(data.threshold)}`}
      suffix={
        data.relative
          ? `% within ${formatter.format(data.within / 1000)}s`
          : ` within ${formatter.format(data.within / 1000)}s`
      }
    />
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    behaviour: {
      value: data.behaviour,
      options: {
        "when increasing": "increasing",
        "when decreasing": "decreasing",
      },
    },
    threshold: { value: data.threshold!, min: 0, label: "by" },
    within: { value: data.within, min: 1, step: 50, label: "within (ms)" },
    advanced: folder(
      {
        relative: { value: data.relative!, label: "percentage" },
      },
      { collapsed: true },
    ),
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Trigger.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "flow",
    tags: ["event", "control"],
    label: "Trigger",
    icon: "TrendingUpIcon",
    description:
      "Send a signal when a value changes by a certain amount, like detecting a sudden change",
  } satisfies Props["data"],
};
