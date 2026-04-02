import { button } from "leva";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base/_base";
import { Handle } from "../../handle";
import { useState } from "react";
import { dataSchema, VALID_HOTKEYS, type Data, type Value, type HotkeyChar } from "./hotkey.schema";
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
import { useHotkeyRecorder } from "@tanstack/react-hotkeys";
import type { Hotkey as HotkeyType } from "@tanstack/react-hotkeys";
import { cn } from "@/lib/utils";

export function Hotkey(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="source" position="right" id="event" handleType="event" offset={-0.5} />
      <Handle type="source" position="right" id="true" handleType="state" offset={0.5} />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(false);

  return (
    <KbdGroup className="flex flex-wrap gap-1 scale-250">
      <Kbd className={cn("min-w-6 h-6 px-2", {
        "text-green-500": value,
        "text-muted-foreground": !value,
      })}>{String(data.accelerator).toUpperCase()}</Kbd>
    </KbdGroup>
  );
}

function isValidHotkeyChar(hotkey: HotkeyType): boolean {
  const key = String(hotkey).toLowerCase();
  return VALID_HOTKEYS.includes(key as HotkeyChar);
}

type HotkeyRecorderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (key: string) => void;
  initialKey?: string;
};

function HotkeyRecorderDialog(props: HotkeyRecorderDialogProps) {
  const [key, setKey] = useState<string | undefined>(props.initialKey);

  const recorder = useHotkeyRecorder({
    onRecord: (hotkey) => {
      if (isValidHotkeyChar(hotkey)) {
        setKey(String(hotkey).toLowerCase());
      }
      // Restart so the user can keep trying if they pressed a modifier combo
      recorder.startRecording();
    },
    onCancel: () => {
      props.onOpenChange(false);
    },
    onClear: () => {
      setKey(undefined);
    },
  });

  const handleOpen = (open: boolean) => {
    if (open) {
      recorder.startRecording();
    } else {
      recorder.stopRecording();
    }
    props.onOpenChange(open);
  };

  // Start recording when dialog opens
  if (props.open && !recorder.isRecording) {
    recorder.startRecording();
  }

  return (
    <Dialog open={props.open} onOpenChange={handleOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set hotkey</DialogTitle>
          <DialogDescription>
            Press a key to assign as a trigger
          </DialogDescription>
        </DialogHeader>
        <section className="min-h-24 flex flex-col gap-4 items-center justify-center">
          <KbdGroup className="flex flex-wrap gap-1 scale-300">
            <Kbd className="min-w-6 h-6 px-2">{key?.toUpperCase()}</Kbd>
          </KbdGroup>
        </section>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              recorder.stopRecording();
              props.onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="outline" onClick={() => setKey(undefined)} disabled={!key}>
            Clear
          </Button>
          <Button
            onClick={() => {
              if (key) {
                recorder.stopRecording();
                props.onSave(key);
                props.onOpenChange(false);
              }
            }}
            disabled={!key}
          >
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
    group: "sense",
    tags: ["trigger", "source"],
    label: "Hotkey",
    icon: "KeyboardIcon",
    description: "Detect when a keyboard key is pressed or released",
  } satisfies Props["data"],
};
