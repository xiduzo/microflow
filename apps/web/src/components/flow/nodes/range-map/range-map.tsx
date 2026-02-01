import { useNodeValue } from "@/stores/node-data";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { type Data, type Value, dataSchema } from "./range-map.schema";
import { ActivityIcon } from "lucide-react";

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

export function RangeMap(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="value" handleType="value" />
      <Handle type="source" position="right" id="value" handleType="value" />
    </NodeContainer>
  );
}

function Value() {
  const rawValue = useNodeValue<Value | number>([0, 0]);
  const [from, to] = Array.isArray(rawValue) ? rawValue : [rawValue, rawValue];
  const data = useNodeData<Data>();

  return (
    <section className="flex grow items-center flex-col space-y-2 text-2xl">
      <div className="grow w-full grid grid-cols-12">
        <span className="text-xs text-muted-foreground col-span-3 flex items-center justify-center">
          {data.from.min}
        </span>
        <span className="col-span-6 text-center">{numberFormat.format(from)}</span>
        <span className="text-xs text-muted-foreground col-span-3 flex items-center justify-center">
          {data.from.max}
        </span>
      </div>
      <ActivityIcon className="rotate-90 text-muted-foreground" size={16} />
      <div className="grid w-full grid-cols-12">
        <span className="text-xs text-muted-foreground col-span-3 flex items-center justify-center">
          {data.to.min}
        </span>
        <span className="col-span-6 text-center">{numberFormat.format(to)}</span>
        <span className="text-xs text-muted-foreground col-span-3 flex items-center justify-center">
          {data.to.max}
        </span>
      </div>
    </section>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    from: { value: data.from, step: 1, joystick: false },
    to: { value: data.to, step: 1, joystick: false },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
RangeMap.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "shape",
    tags: ["value"],
    icon: "SeparatorVerticalIcon",
    label: "Map",
    description:
      "Convert a number from one range to another, like turning a sensor reading into a brightness value",
  } satisfies Props["data"],
};
