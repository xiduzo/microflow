import {
  ContextMenuContent,
  ContextMenuItem,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  Slider,
  Button as UiButton,
} from "@fhb/ui";
import { Position, useReactFlow, type Node } from "@xyflow/react";
import { ButtonOption } from "johnny-five";
import { useShallow } from "zustand/react/shallow";
import { SelectGroup } from "../../../../../out/Figma hardware bridge-darwin-arm64/Figma hardware bridge.app/Contents/Resources/app/packages/ui";
import useNodesEdgesStore, { nodeSelector } from "../../../store";
import { BaseComponent } from "./BaseComponent";
import { Handle } from "./Handle";

export function Button(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<ButtonData>(props.id)),
  );
  const { updateNodeData } = useReactFlow();

  if (!node) return null;

  return (
    <BaseComponent
      {...props}
      contextMenu={
        <ContextMenuContent>
          <ContextMenuItem>foo</ContextMenuItem>
          <ContextMenuItem>bar</ContextMenuItem>
        </ContextMenuContent>
      }
    >
      <section className="flex flex-col space-y-4 mb-6">
        <section className="flex p-12 justify-center items-center h-11 bg-zinc-700 rounded-md">
          <UiButton>Click me</UiButton>
        </section>
        <Select
          value={node.data.pin.toString()}
          onValueChange={(value) =>
            updateNodeData(props.id, { pin: parseInt(value) })
          }
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
        <Label htmlFor="holdtime" className="flex justify-between">
          Hold time
          <span className="opacity-40 font-light">
            {node.data?.holdtime ?? 500}
          </span>
        </Label>
        <Slider
          id="holdtime"
          defaultValue={[node.data?.holdtime ?? 500]}
          min={100}
          max={2000}
          step={25}
          onValueChange={(value) =>
            updateNodeData(props.id, { holdtime: value[0] })
          }
        />
      </section>
      <Handle type="source" index={-1} position={Position.Bottom} id="up" />
      <Handle type="source" position={Position.Bottom} id="hold" />
      <Handle type="source" index={1} position={Position.Bottom} id="down" />
    </BaseComponent>
  );
}

export type ButtonData = Omit<ButtonOption, "board">;
type Props = Node<ButtonData>;
