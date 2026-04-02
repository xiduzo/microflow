import { button, folder } from "leva";
import { Handle } from "../../handle";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { useState } from "react";
import { MODES } from "@/stores/board";
import { pinsToOptions } from "@/components/hardware/pin";
import { SongEditor } from "./song-editor";
import { usePins } from "@/stores/board";
import {
  type BuzzData,
  type Data,
  type SongData,
  type Value,
  dataSchema,
} from "./piezo.schema";
import { BellIcon, BellRingIcon, Disc3Icon, DiscIcon } from "lucide-react";
import {
  DEFAULT_NOTE,
  DEFAULT_SONG,
  NOTES_AND_FREQUENCIES,
} from "./piezo.constants";

export function Piezo(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      {props.data.type === "buzz" && (
        <Handle type="target" position="left" id="trigger" handleType="command" offset={-0.5} />
      )}
      {props.data.type === "song" && (
        <Handle type="target" position="left" id="trigger" handleType="command" offset={-0.5} title="play" />
      )}
      <Handle type="target" position="left" id="stop" handleType="command" offset={0.5} />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(false);

  if (!value) {
    if (data.type === "song")
      return <DiscIcon className="text-muted-foreground" size={48} />;
    return <BellIcon className="text-muted-foreground" size={48} />;
  }

  if (data.type === "song")
    return <Disc3Icon className="animate-spin" size={48} />;
  return <BellRingIcon className="animate-wiggle" size={48} />;
}

function Settings() {
  const data = useNodeData<Data>();
  const pins = usePins([MODES.INPUT, MODES.PWM]);
  const [editorOpened, setEditorOpened] = useState(false);
  const { render, setNodeData } = useNodeControls<Data>(
    {
      pin: { options: pinsToOptions(pins), value: data.pin },
      type: {
        options: ["buzz", "song"],
        value: data.type,
        transient: false,
        onChange: (event) => {
          setNodeData({
            ...data,
            type: event,
            tempo: event === "song" ? 113 : undefined,
            song: event === "song" ? ((data as SongData).song?.length ? (data as SongData).song : DEFAULT_SONG) : undefined,
            duration: event === "buzz" ? 500 : undefined,
          });
        },
      },
      buzz: folder(
        {
          duration: {
            min: 100,
            max: 2500,
            step: 100,
            value: (data as BuzzData).duration,
            render: (get) => get("type") === "buzz",
          },
          frequency: {
            options: Object.fromEntries(NOTES_AND_FREQUENCIES.entries()),
            value: data.frequency!,
            render: (get) => get("type") === "buzz",
          },
        },
        {
          render: (get) => get("type") === "buzz",
        }
      ),
      songSettings: folder(
        {
          tempo: {
            min: 40,
            max: 240,
            step: 1,
            value: (data as SongData).tempo ?? 113,
          },
          "edit song": button(() => setEditorOpened(true)),
        },
        {
          render: (get) => get("type") === "song",
        }
      ),
    },
    [pins]
  );

  return (
    <>
      {render()}
      {editorOpened && (
        <SongEditor
          song={(data as SongData).song ?? DEFAULT_SONG}
          title={data.label}
          onClose={() => {
            setEditorOpened(false);
          }}
          onSave={(data) => {
            setNodeData(data);
            setEditorOpened(false);
          }}
        />
      )}
    </>
  );
}

export const DEFAULT_FREQUENCY = NOTES_AND_FREQUENCIES.get(DEFAULT_NOTE);

type Props = BaseNode<Data>;
Piezo.defaultProps = {
  data: {
    ...dataSchema.parse({ type: "buzz" }),
    group: "express",
    tags: ["action"],
    label: "Piezo",
    icon: "BellIcon",
    description: "Play tones, beeps, or melodies through a piezo buzzer — a small speaker common in Arduino kits",
  } satisfies Props["data"],
};
