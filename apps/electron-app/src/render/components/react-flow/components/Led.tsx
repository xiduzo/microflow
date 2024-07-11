import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  Switch,
} from "@fhb/ui";
import { Node, Position, useReactFlow } from "@xyflow/react";
import { LedOption } from "johnny-five";
import { useShallow } from "zustand/react/shallow";
import useNodesEdgesStore, { nodeSelector } from "../../../store";
import { BaseComponent } from "./BaseComponent";
import { Handle } from "./Handle";

export function Led(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<LedData>(props.id)),
  );
  const { updateNodeData } = useReactFlow();

  if (!node) return null;

  function handleValueChange(pin: string) {
    updateNodeData(props.id, { pin: parseInt(pin) });
  }

  return (
    <BaseComponent {...props}>
      <section className="flex flex-col space-y-4">
        <section className="flex p-12 justify-center items-center h-11 bg-zinc-700 rounded-md">
          <Switch className="scale-150" />
        </section>
        <Select
          value={node.data.pin.toString()}
          onValueChange={handleValueChange}
        >
          <SelectTrigger>Pin ({node.data.pin.toString()})</SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Set button pin</SelectLabel>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((pin) => (
                <SelectItem key={pin} value={pin.toString()}>
                  {pin}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </section>
      <section className="flex justify-between">
        <Handle index={-1} type="target" position={Position.Top} id="on" />
        <Handle type="target" position={Position.Top} id="toggle" />
        <Handle index={1} type="target" position={Position.Top} id="off" />
      </section>
    </BaseComponent>
  );
}

export type LedData = Omit<LedOption, "board">;
type Props = Node<LedData>;
