import { Label, Slider } from "@fhb/ui";
import { Position } from "@xyflow/react";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

const numberFormat = new Intl.NumberFormat();

export function Interval(props: Props) {
  const { updateNodeData } = useUpdateNodeData<IntervalData>(props.id);

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="tabular-nums">
          {numberFormat.format(Math.round(props.data.value ?? 0))}
        </NodeHeader>
        <Label
          htmlFor={`interval-${props.id}`}
          className="flex justify-between"
        >
          Interval
          <span className="opacity-40 font-light">
            {props.data.interval ?? 500}ms
          </span>
        </Label>
        <Slider
          id={`interval-${props.id}`}
          className="pb-2"
          defaultValue={[props.data.interval ?? 500]}
          min={500}
          max={5000}
          step={100}
          onValueChange={(value) => updateNodeData({ interval: value[0] })}
        />
      </NodeContent>
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type IntervalData = { interval?: number };
type Props = AnimatedNode<IntervalData, number>;
