import { MODES, usePins } from "@/stores/board";
import { folder } from "leva";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base";
import { Handle } from "../../handle";
import { useNodeValue } from "@/stores/node-data";
import { dataSchema, type Data, type Value } from "./button.schema";
import { reducePinsToOptions } from "@/components/hardware/pin";
import { PointerIcon, PointerOffIcon } from "lucide-react";

export function Button(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="source" position="right" id="active" offset={-1.5} />
      <Handle type="source" position="right" id="change" offset={-0.5} />
      <Handle type="source" position="right" id="inactive" offset={0.5} />
      <Handle type="source" position="right" id="hold" offset={1.5} />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(false);

  if (!value)
    return <PointerOffIcon className="text-muted-foreground" size={48} />;
  return <PointerIcon className="text-green-500" size={48} />;
}

const DEFAULT = 0;
const PULL_UP = 1;
const PULL_DOWN = 2;

function Settings() {
  const data = useNodeData<Data>();

  const requiresPullup = data.isPullup || data.isPulldown;
  const pins = usePins(
    requiresPullup ? [MODES.PULLUP, MODES.INPUT] : [MODES.INPUT]
  );

  const { render, set } = useNodeControls(
    {
      pin: { options: pins.reduce(reducePinsToOptions, {}), value: data.pin },
      isPullup: { value: data.isPullup!, render: () => false },
      isPulldown: { value: data.isPulldown!, render: () => false },

      advanced: folder(
        {
          type: {
            value: data.isPulldown
              ? PULL_DOWN
              : data.isPullup
              ? PULL_UP
              : DEFAULT,
            options: {
              default: DEFAULT,
              "pull up": PULL_UP,
              "pull down": PULL_DOWN,
            },
            onChange: (value) =>
              set({
                isPullup: value === PULL_UP,
                isPulldown: value === PULL_DOWN,
              }),
          },
          holdtime: {
            min: 100,
            step: 50,
            value: data.holdtime!,
            label: "hold time (ms)",
          },
        },
        { collapsed: true }
      ),
    },
    [pins]
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Button.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "hardware",
    tags: ["input", "digital"],
    icon: PointerIcon,
    label: "Button",
    description: "Detect when a physical button is pressed or released",
  } satisfies Props["data"],
};
