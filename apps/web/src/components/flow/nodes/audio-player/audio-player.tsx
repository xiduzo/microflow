import { Handle } from "../../handle";
import { Position } from "@xyflow/react";
import { NodeContainer, type BaseNode } from "../_base";
import { useNodeData } from "../_base";
import { useNodeValue } from "@/stores/node-data";
import { button } from "leva";
import { AudioFileEditor } from "./audio-file-editor";
import {
  type Data,
  type Value,
  dataSchema,
} from "@microflow/runtime/audio-player/audio-player.types";
import { useState } from "react";
import { useNodeControls } from "../_base";
import { Volume2Icon, VolumeOffIcon } from "lucide-react";
import { IconWithValue } from "../../icon-with-value";

export function AudioPlayer(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position={Position.Left} id="play" offset={-0.5} />
      <Handle type="target" position={Position.Left} id="stop" offset={0.5} />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const isPlaying = useNodeValue<Value>(false);

  return (
    <IconWithValue
      icon={isPlaying ? Volume2Icon : VolumeOffIcon}
      value={data.audioFiles.length}
      suffix=" files"
      iconClassName={isPlaying ? "text-green-500" : "text-muted-foreground"}
    />
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const [editorOpened, setEditorOpened] = useState(false);
  const { render, setNodeData } = useNodeControls<Data>(
    {
      volume: {
        value: data.volume ?? 1,
        min: 0,
        max: 1,
        step: 0.1,
        label: "volume",
      },
      loop: {
        value: data.loop ?? false,
        label: "loop",
      },
      "manage files": button(() => {
        setEditorOpened(true);
      }),
    },
    [],
  );

  return (
    <>
      {render()}
      {editorOpened && (
        <AudioFileEditor
          audioFiles={data.audioFiles}
          onClose={() => {
            setEditorOpened(false);
          }}
          onSave={(newData) => {
            setNodeData({
              ...data,
              audioFiles: newData.audioFiles,
            });
            setEditorOpened(false);
          }}
        />
      )}
    </>
  );
}

type Props = BaseNode<Data>;
AudioPlayer.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "flow",
    tags: ["output", "event"],
    label: "Audio Player",
    icon: "MusicIcon",
    description: "Select and play audio files from your device",
  } satisfies Props["data"],
};
