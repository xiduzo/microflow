import { button } from "leva";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  useNodeId,
  type BaseNode,
} from "../_base";
import { Handle } from "../../handle";
import { useEffect, useState } from "react";
import { dataSchema, type Data, type Value } from "./hotkey.schema";
import { useNodeValue } from "@/stores/node-data";
import { IconWithValue } from "../../icon-with-value";
import { KeyboardIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Button } from "@/components/ui/button";

export function Hotkey(props: Props) {
  return (
    <NodeContainer {...props}>
      <HotkeyHandler />
      <Value />
      <Settings />
      <Handle type="source" position="right" id="pressed" offset={-0.5} />
      <Handle type="source" position="right" id="released" offset={0.5} />
    </NodeContainer>
  );
}

function HotkeyHandler() {
  const data = useNodeData<Data>();
  const nodeId = useNodeId();

  useEffect(() => {
    if (!data.accelerator) return;

    // hotkeys(data.accelerator, { keyup: true }, event => {
    // 	if (event.repeat) return;
    // 	window.electron.ipcRenderer.send('ipc-external-value', {
    // 		nodeId: nodeId,
    // 		value: event.type === 'keydown',
    // 	});
    // });

    // return () => {
    // 	hotkeys.unbind(data.accelerator);
    // };
  }, [data.accelerator, nodeId]);

  return null;
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(false);

  return (
    <IconWithValue
      icon={KeyboardIcon}
      value={data.accelerator}
      iconClassName={value ? "text-green-500" : "text-muted-foreground"}
    />
  );
}

type HotkeyRecorderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (accelerator: string) => void;
  initialKey?: string;
};

function convertKeyboardEventToHotkeyJsString(event: KeyboardEvent) {
  const code = event.code;

  switch (code) {
    case "MetaLeft":
    case "MetaRight":
    case "Meta":
    case "ControlLeft":
    case "ControlRight":
    case "Control":
    case "AltLeft":
    case "AltRight":
    case "Alt":
    case "ShiftLeft":
    case "ShiftRight":
    case "Shift":
      return null;
    case "Digit0":
    case "Digit1":
    case "Digit2":
    case "Digit3":
    case "Digit4":
    case "Digit5":
    case "Digit6":
    case "Digit7":
    case "Digit8":
    case "Digit9":
      return code.replace("Digit", "");
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
      return code.replace("Arrow", "");
    default:
      return code.replace("Key", "");
  }
}

function HotkeyRecorderDialog(props: HotkeyRecorderDialogProps) {
  const [key, setKey] = useState<string | undefined>(props.initialKey);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();

      const key = convertKeyboardEventToHotkeyJsString(event);
      if (!key) return;
      setKey(key);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleSave = () => {
    if (!key) return;
    props.onSave(key);
    props.onOpenChange(false);
  };

  const handleCancel = () => {
    props.onOpenChange(false);
  };

  const handleClear = () => {
    setKey(undefined);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set hotkey</DialogTitle>
          <DialogDescription>
            Press the key you want to create a trigger for
          </DialogDescription>
        </DialogHeader>
        <section className="min-h-24 flex flex-col gap-4 items-center justify-center">
          <KbdGroup className="flex flex-wrap gap-1">
            <Kbd className="min-w-6 h-6 px-2">{key}</Kbd>
          </KbdGroup>
        </section>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={handleClear} disabled={!key}>
            Clear
          </Button>
          <Button onClick={handleSave} disabled={!key}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const [dialogOpened, setDialogOpened] = useState(false);

  const { render, set } = useNodeControls<Data>({
    accelerator: {
      value: data.accelerator,
      render: () => false,
    },
    "set hotkey": button(() => setDialogOpened(true)),
  });

  return (
    <>
      {render()}
      {dialogOpened && (
        <HotkeyRecorderDialog
          initialKey={data.accelerator}
          open={dialogOpened}
          onOpenChange={setDialogOpened}
          onSave={(accelerator) => {
            set({ accelerator });
            setDialogOpened(false);
          }}
        />
      )}
    </>
  );
}

type Props = BaseNode<Data>;
Hotkey.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "flow",
    tags: ["event", "input"],
    label: "Hotkey",
    icon: KeyboardIcon,
    description: "Detect when a keyboard shortcut is pressed or released",
  } satisfies Props["data"],
};
