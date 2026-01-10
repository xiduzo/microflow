import { button, folder } from "leva";
import { Handle } from "../../handle";
import {
  NodeContainer,
  useDeleteHandles,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base";
import { useNodeValue } from "@/stores/node-data";
import { useState } from "react";
import { MODES } from "@/stores/board";
import { reducePinsToOptions } from "@/components/hardware/pin";
import { SongEditor } from "./song-editor";
import { usePins } from "@/stores/board";
import {
  type BuzzData,
  type Data,
  type SongData,
  type Value,
  dataSchema,
} from "@microflow/runtime/piezo/piezo.types";
import { BellIcon, BellRingIcon, Disc3Icon, DiscIcon } from "lucide-react";
import {
  DEFAULT_NOTE,
  DEFAULT_SONG,
  NOTES_AND_FREQUENCIES,
} from "@microflow/runtime/piezo/piezo.constants";

export function Piezo(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      {props.data.type === "buzz" && (
        <Handle type="target" position="left" id="buzz" offset={-0.5} />
      )}
      {props.data.type === "song" && (
        <Handle type="target" position="left" id="play" offset={-0.5} />
      )}
      <Handle type="target" position="left" id="stop" offset={0.5} />
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
  const deleteHandles = useDeleteHandles();

  const { render, setNodeData } = useNodeControls<Data>(
    {
      pin: { options: pins.reduce(reducePinsToOptions, {}), value: data.pin },
      type: {
        options: ["buzz", "song"],
        value: data.type,
        transient: false,
        onChange: (event) => {
          deleteHandles(event === "song" ? ["buzz"] : ["play"]);
          setNodeData({
            ...data,
            type: event,
            tempo: event === "song" ? 120 : undefined,
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
      song: folder(
        {
          tempo: {
            min: 40,
            max: 240,
            step: 10,
            value: (data as SongData).tempo ?? 120,
          },
          "edit song": button((e) => setEditorOpened(true)),
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
            data.song = data.song;
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
    group: "hardware",
    tags: ["output", "analog", "digital"],
    label: "Piezo",
    icon: BellIcon,
    description:
      "Make sounds, play tones, or create melodies using a buzzer or speaker",
  } satisfies Props["data"],
};
