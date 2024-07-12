import {
  Badge,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuSeparator,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  Separator,
  Slider,
  Button as UiButton,
} from "@fhb/ui";
import { Position, useReactFlow, type Node } from "@xyflow/react";
import { ButtonOption } from "johnny-five";
import { useShallow } from "zustand/react/shallow";
import { SelectGroup } from "../../../../../out/Figma hardware bridge-darwin-arm64/Figma hardware bridge.app/Contents/Resources/app/packages/ui";
import useNodesEdgesStore, { nodeSelector } from "../../../store";
import { NodeContainer, NodeContent, NodeHeader } from "./BaseComponent";
import { Handle } from "./Handle";

export function Button(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<ButtonData>(props.id)),
  );
  const { updateNodeData } = useReactFlow();

  if (!node) return null;

  const hasMetadata =
    node.data.invert || node.data.isPullup || node.data.isPulldown;

  return (
    <NodeContainer
      {...props}
      contextMenu={
        <ContextMenuContent>
          <ContextMenuCheckboxItem
            checked={node.data.invert}
            onClick={() =>
              updateNodeData(props.id, { invert: !node.data.invert })
            }
          >
            Invert
          </ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={node.data.isPullup}
            onClick={() =>
              updateNodeData(props.id, {
                isPullup: !node.data.isPullup,
                isPulldown: false,
              })
            }
          >
            Initialize as a pullup button
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={node.data.isPulldown}
            onClick={() =>
              updateNodeData(props.id, {
                isPulldown: !node.data.isPulldown,
                isPullup: false,
              })
            }
          >
            Initialize as a pulldown button
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      }
    >
      <NodeContent>
        <NodeHeader>
          <UiButton>Click me</UiButton>
        </NodeHeader>
        <Select
          value={node.data.pin.toString()}
          onValueChange={(value) =>
            updateNodeData(props.id, { pin: parseInt(value) })
          }
        >
          <SelectTrigger>Pin {node.data.pin}</SelectTrigger>
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
            {node.data?.holdtime ?? 500} ms
          </span>
        </Label>
        <Slider
          id="holdtime"
          className="pb-2"
          defaultValue={[node.data?.holdtime ?? 500]}
          min={100}
          max={2000}
          step={25}
          onValueChange={(value) =>
            updateNodeData(props.id, { holdtime: value[0] })
          }
        />
        {hasMetadata && <Separator className="my-3" />}
        {hasMetadata && (
          <section className="flex space-x-2">
            {node.data.invert && <Badge>Inverted</Badge>}
            {node.data.isPullup && <Badge>Pull up</Badge>}
            {node.data.isPulldown && <Badge>Pull down</Badge>}
          </section>
        )}
      </NodeContent>
      <Handle type="source" index={-1} position={Position.Bottom} id="up" />
      <Handle type="source" position={Position.Bottom} id="hold" />
      <Handle type="source" index={1} position={Position.Bottom} id="down" />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type ButtonData = Omit<ButtonOption, "board">;
type Props = Node<ButtonData>;
