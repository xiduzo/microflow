import { KeyboardMusicIcon, MusicIcon } from "lucide-react";
import { button, folder } from "leva";
import { useMemo, useState } from "react";
import { Handle as BaseHandle } from "../../handle";
import { IconWithValue } from "../../icon-with-value";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { MidiSongEditor } from "./midi-song-editor";
import { DEFAULT_MIDI_SONG } from "./midi.constants";
import { dataSchema, defaults, type Data } from "./midi.schema";

const Handle = BaseHandle<"Midi">;

export function Midi(props: Props) {
  const { direction, mode } = props.data;
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      {direction === "out" && (
        <Handle type="target" position="left" id="send" handleType="command" />
      )}
      {direction === "in" && mode === "note" && (
        <>
          <Handle type="source" position="right" id="note" handleType="value" offset={-1.5} />
          <Handle type="source" position="right" id="velocity" handleType="value" offset={-0.5} />
          <Handle type="source" position="right" id="on" handleType="command" offset={0.5} />
          <Handle type="source" position="right" id="off" handleType="command" offset={1.5} />
        </>
      )}
      {direction === "in" && mode === "cc" && (
        <Handle type="source" position="right" id="value" handleType="value" />
      )}
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();

  const displayValue = useMemo(() => {
    const device = data.deviceName || "all devices";
    const what = data.mode === "cc" ? `CC ${data.control}` : data.mode === "song" ? "song" : "notes";
    return `${what} · ${device}`;
  }, [data.deviceName, data.mode, data.control]);

  return (
    <IconWithValue
      icon={data.direction === "out" ? MusicIcon : KeyboardMusicIcon}
      value={displayValue}
    />
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const [editorOpened, setEditorOpened] = useState(false);

  // Song is an out-only playback mode (there's nothing to listen to).
  const modeOptions =
    data.direction === "out"
      ? { "note on/off": "note", "control change": "cc", song: "song" }
      : { "note on/off": "note", "control change": "cc" };

  const { render, setNodeData } = useNodeControls<Data>(
    {
      direction: {
        value: data.direction,
        options: ["in", "out"],
      },
      deviceName: {
        value: data.deviceName,
        label: "device (blank = all)",
      },
      channel: {
        value: data.channel,
        min: data.direction === "in" ? 0 : 1,
        max: 16,
        step: 1,
        label: data.direction === "in" ? "channel (0 = all)" : "channel",
      },
      mode: {
        value: data.mode,
        // Leva options are { [label]: value }; value side must be the
        // "note"|"cc"|"song" the schema/runtime expect, not the human label.
        options: modeOptions,
      },
      ...(data.mode === "cc" && {
        control: { value: data.control, min: 0, max: 127, step: 1, label: "cc number" },
      }),
      ...(data.direction === "out" &&
        data.mode === "note" && {
          note: { value: data.note, min: 0, max: 127, step: 1 },
        }),
      // Velocity drives both a single note and every note in a song.
      ...(data.direction === "out" &&
        (data.mode === "note" || data.mode === "song") && {
          velocity: { value: data.velocity, min: 0, max: 127, step: 1 },
        }),
      ...(data.direction === "out" &&
        data.mode === "song" && {
          // Folder key must not be "song" — that path would collide with the
          // `song` data array (Piezo names its folder "songSettings" for this).
          songSettings: folder({
            // Fall back for nodes created before song mode existed.
            tempo: { value: data.tempo ?? 113, min: 40, max: 240, step: 1 },
            "edit song": button(() => setEditorOpened(true)),
          }),
        }),
    },
    [data.direction, data.mode],
  );

  return (
    <>
      {render()}
      {editorOpened && (
        <MidiSongEditor
          song={data.song ?? DEFAULT_MIDI_SONG}
          title={data.label}
          onClose={() => setEditorOpened(false)}
          onSave={(saved) => {
            setNodeData({ ...data, ...saved });
            setEditorOpened(false);
          }}
        />
      )}
    </>
  );
}

type Props = BaseNode<Data>;
Midi.defaultProps = { data: defaults };
