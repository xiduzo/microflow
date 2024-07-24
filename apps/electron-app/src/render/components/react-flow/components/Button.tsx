import {
  Badge,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuSeparator,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Separator,
  Slider,
  Button as UiButton,
} from "@fhb/ui";
import { Position } from "@xyflow/react";
import { ButtonOption } from "johnny-five";
import { MODES } from "../../../../common/types";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { useBoard } from "../../../providers/BoardProvider";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function Button(props: Props) {
  const { checkResult } = useBoard();

  const { updateNodeData } = useUpdateNodeData<ButtonData>(props.id);

  const hasMetadata =
    props.data.invert || props.data.isPullup || props.data.isPulldown;

  return (
    <NodeContainer
      {...props}
      contextMenu={
        <ContextMenuContent>
          <ContextMenuCheckboxItem
            checked={props.data.invert}
            onClick={() => updateNodeData({ invert: !props.data.invert })}
          >
            Invert
          </ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={props.data.isPullup}
            onClick={() =>
              updateNodeData({
                isPullup: !props.data.isPullup,
                isPulldown: false,
              })
            }
          >
            Initialize as a pullup button
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={props.data.isPulldown}
            onClick={() =>
              updateNodeData({
                isPulldown: !props.data.isPulldown,
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
          <UiButton disabled variant={props.data.value ? "default" : "outline"}>
            {props.id}
          </UiButton>
        </NodeHeader>
        <Select
          value={props.data.pin.toString()}
          onValueChange={(value) => updateNodeData({ pin: parseInt(value) })}
        >
          <SelectTrigger>Pin {props.data.pin}</SelectTrigger>
          <SelectContent>
            {checkResult.pins
              ?.filter((pin) => pin.supportedModes.includes(MODES.INPUT))
              .map((pin) => (
                <SelectItem key={pin.pin} value={pin.pin.toString()}>
                  Pin {pin.pin}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Label
          htmlFor={`holdtime-${props.id}`}
          className="flex justify-between"
        >
          Hold time
          <span className="opacity-40 font-light">
            {props.data.holdtime ?? 500} ms
          </span>
        </Label>
        <Slider
          id={`holdtime-${props.id}`}
          className="pb-2"
          defaultValue={[props.data.holdtime ?? 500]}
          min={500}
          max={2500}
          step={50}
          onValueChange={(value) =>
            updateNodeData({ holdtime: value[0] })
          }
        />
        {hasMetadata && <Separator className="my-3" />}
        {hasMetadata && (
          <section className="flex space-x-2">
            {props.data.invert && <Badge>Inverted</Badge>}
            {props.data.isPullup && <Badge>Pull up</Badge>}
            {props.data.isPulldown && <Badge>Pull down</Badge>}
          </section>
        )}
      </NodeContent>
      <Handle type="source" position={Position.Bottom} id="down" offset={-1} />
      <Handle type="source" position={Position.Bottom} id="hold" />
      <Handle type="source" position={Position.Bottom} id="up" offset={1} />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type ButtonData = Omit<ButtonOption, "board">;
type Props = AnimatedNode<ButtonData, boolean>;
