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
        <NodeHeader className="text-4xl tabular-nums">
          {props.data.value?.[0] ?? 0}
        </NodeHeader>
        <section className="flex flex-col space-y-3">
          <section className="flex flex-col">
            <div className="flex space-x-2 justify-between">
              <Input type="number" defaultValue={props.data.from[0]} onChange={event => updateNodeData({
                from: [Number(event.target.value), props.data.from[1]]
              })} />
              <Input type="number" defaultValue={props.data.from[1]} onChange={event => updateNodeData({
                from: [props.data.from[0], Number(event.target.value)]
              })} />
            </div>
          </section>
          <span className="w-full flex justify-center">
            <Icons.Sigma />
          </span>
          <section className="flex flex-col">
            <div className="flex space-x-2 justify-between">
              <Input type="number" defaultValue={props.data.to[0]} onChange={event => updateNodeData({
                to: [Number(event.target.value), props.data.to[1]]
              })} />
              <Input type="number" defaultValue={props.data.to[1]} onChange={event => updateNodeData({
                to: [props.data.to[0], Number(event.target.value)]
              })} />
            </div>
          </section>
        </section>
        <NodeHeader className="text-4xl tabular-nums">
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
