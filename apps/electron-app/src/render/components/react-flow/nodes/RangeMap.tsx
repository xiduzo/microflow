import { Icons, Input } from "@fhb/ui";
import { Position } from "@xyflow/react";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function RangeMap(props: Props) {
  const { updateNodeData } = useUpdateNodeData<RangeMapData>(props.id);


  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader className="text-4xl tabular-nums" valueOverride={props.data.value?.[0]}>
          {props.data.value?.[0] ?? 0}
        </NodeHeader>
        <section className="flex flex-col space-y-3">
          <section className="flex space-x-2 justify-between items-center">
            <Input type="number" className="w-20" defaultValue={props.data.from[0]} onChange={event => updateNodeData({
              from: [Number(event.target.value), props.data.from[1]]
            })} />
            <span className="text-gray-800">-</span>
            <Input type="number" className="w-20" defaultValue={props.data.from[1]} onChange={event => updateNodeData({
              from: [props.data.from[0], Number(event.target.value)]
            })} />
          </section>
          <span className="w-full flex justify-center">
            <Icons.ArrowsUpFromLine className="rotate-180" />
          </span>
          <section className="flex space-x-2 justify-between items-center">
            <Input type="number" className="w-20" defaultValue={props.data.to[0]} onChange={event => updateNodeData({
              to: [Number(event.target.value), props.data.to[1]]
            })} />
            <span className="text-gray-800">-</span>
            <Input type="number" className="w-20" defaultValue={props.data.to[1]} onChange={event => updateNodeData({
              to: [props.data.to[0], Number(event.target.value)]
            })} />
          </section>
        </section>
        <NodeHeader className="text-4xl tabular-nums" valueOverride={props.data.value?.[1]}>
          {props.data.value?.[1] ?? 0}
        </NodeHeader>
      </NodeContent>
      <Handle type="target" position={Position.Top} id="from" />
      <Handle type="source" position={Position.Bottom} id="to" />
    </NodeContainer>
  );
}

export type RangeMapData = {
  from: number[]
  to: number[]
};
type Props = AnimatedNode<RangeMapData, number[]>;
