import { button, folder } from "leva";
import { Disc3Icon, Music4Icon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useUpdateNodeInternals } from "@xyflow/react";
import { toast } from "sonner";
import { useNodeHandleValue, useNodeValue } from "@/stores/node-data";
import { dispatchPort } from "@/lib/firmata/dispatch-port";
import { Handle as BaseHandle } from "../../handle";
import {
  NodeContainer,
  useDeleteHandles,
  useNodeControls,
  useNodeData,
  useNodeId,
  type BaseNode,
} from "../_base/_base";
import { NodeHandles } from "../_base/node-handles";
import {
  MAX_FILE_BYTES,
  MAX_HANDLES,
  MAX_TOTAL_BYTES,
  defaults,
  type Data,
  type Track,
  type Value,
} from "./music.schema";

/**
 * The node's data with every field present. A node's `data` is whatever is in
 * the flow document, which may predate a field (this node shipped with a single
 * `src` before it held a stack of records) — so nothing downstream may assume a
 * key exists. {@link Settings} rewrites a stale node once, in place.
 */
function useMusicData(): Data {
  const data = useNodeData<Partial<Data>>();
  return useMemo(
    () => ({
      ...defaults,
      ...data,
      tracks: data.tracks ?? [],
      track: data.track ?? 0,
      volume: data.volume ?? defaults.volume,
      loop: data.loop ?? defaults.loop,
    }),
    [data],
  );
}

export function Music(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles
        instance="Music"
        portOverrides={{
          play: { handleType: "command", offset: -1 },
          stop: { handleType: "command", offset: 0 },
          set: { handleType: "value", offset: 1, hint: "name or number" },
        }}
        emitOverrides={{
          value: { handleType: "value", offset: -0.5 },
          track: { handleType: "value", offset: 0.5 },
        }}
      />
      <RecordHandles />
    </NodeContainer>
  );
}

function Value() {
  const data = useMusicData();
  const playing = useNodeValue<Value>(false);
  // The runtime announces the selected record on the `track` handle; before it
  // has run, the configured selection is what will play.
  const selected = useNodeHandleValue<string>(
    "track",
    data.tracks[data.track]?.name ?? "",
  );

  return (
    <section className="flex flex-col items-center gap-1">
      {playing ? (
        <Disc3Icon className="animate-spin" size={48} />
      ) : (
        <Music4Icon className="text-muted-foreground" size={48} />
      )}
      <span className="text-muted-foreground max-w-32 truncate text-xs">
        {selected || "no songs yet"}
      </span>
    </section>
  );
}

/** One target handle per record, named after it — wire a trigger to a record to
 *  play that one. The open-port outlier the `Function` node also uses: these are
 *  not catalogued **Ports**, so they take the raw handle with a cast id. */
function RecordHandles() {
  const data = useMusicData();
  const id = useNodeId();
  const deleteHandles = useDeleteHandles();
  const update = useUpdateNodeInternals();
  const previous = useRef<string[]>([]);

  const names = useMemo(
    () => data.tracks.slice(0, MAX_HANDLES).map((track) => track.name),
    [data.tracks],
  );

  useEffect(() => {
    // Removing a record must take its edges with it, or the runtime keeps
    // receiving a name it no longer knows.
    const gone = previous.current.filter((name) => !names.includes(name));
    if (gone.length) deleteHandles(gone);
    previous.current = names;
    update(id);
  }, [names, id, update, deleteHandles]);

  return (
    <>
      {names.map((name, index) => (
        <BaseHandle
          key={name}
          type="target"
          position="bottom"
          id={name as never}
          handleType="command"
          title={name}
          offset={index - (names.length - 1) / 2}
        />
      ))}
    </>
  );
}

function Settings() {
  const data = useMusicData();
  const stale = useNodeData<Partial<Data>>().tracks === undefined;
  const nodeId = useNodeId();
  const { render, setNodeData } = useNodeControls<Data>(
    {
      "add songs": button(() => {
        void pickAudioFiles(data.tracks).then((tracks) => {
          if (tracks) setNodeData({ ...data, tracks });
        });
      }),
      // Keyed `track` because a control's key IS the data field it writes;
      // `label` is the only part that is cosmetic. Leva options are
      // `{ [label]: value }` — inverting them would store a name as the index.
      track: {
        label: "record",
        options: Object.fromEntries(data.tracks.map((track, index) => [track.name, index])),
        value: Math.min(data.track, Math.max(data.tracks.length - 1, 0)),
      },
      controls: folder(
        {
          play: button(() => dispatchPort(nodeId, "play", true)),
          stop: button(() => dispatchPort(nodeId, "stop", false)),
          "remove song": button(() => {
            const tracks = data.tracks.filter((_, index) => index !== data.track);
            setNodeData({
              ...data,
              tracks,
              track: Math.min(data.track, Math.max(tracks.length - 1, 0)),
            });
          }),
        },
        { collapsed: true },
      ),
      volume: { min: 0, max: 1, step: 0.05, value: data.volume },
      loop: { value: data.loop },
    },
    // Rebuild the panel when the record list changes, so the dropdown lists it.
    [data.tracks],
  );

  // Rewrite a node saved before records existed: give it the fields the panel
  // and the runtime now read, and drop the single-song keys they replaced.
  useEffect(() => {
    if (!stale) return;
    setNodeData({ ...data, src: undefined, fileName: undefined } as Data);
  }, [stale, data, setNodeData]);

  return render();
}

/**
 * Read audio files off the user's machine as data URLs and append them as
 * records, so the songs travel with the flow instead of pointing at paths only
 * this laptop has. Returns the new record list, or `undefined` when nothing was
 * added.
 */
async function pickAudioFiles(existing: Track[]): Promise<Track[] | undefined> {
  const files = await new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    // A cancelled picker fires no `change`; without this the promise (and the
    // listener behind it) would live until the page went away.
    input.oncancel = () => resolve([]);
    input.click();
  });
  if (files.length === 0) return undefined;

  const tracks = [...existing];
  let total = existing.reduce((sum, track) => sum + track.src.length, 0);

  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      toast.error(
        `"${file.name}" is ${mb(file.size)} MB — songs travel inside the flow, so each must stay under ${mb(MAX_FILE_BYTES)} MB.`,
      );
      continue;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      toast.error(
        `"${file.name}" does not fit — one Music node holds up to ${mb(MAX_TOTAL_BYTES)} MB of songs.`,
      );
      continue;
    }
    const src = await readDataUrl(file);
    if (src === undefined) {
      toast.error(`Could not read "${file.name}"`);
      continue;
    }
    total += file.size;
    tracks.push({ name: uniqueName(file.name, tracks), src });
  }

  return tracks.length === existing.length ? undefined : tracks;
}

function readDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/** A record's name is its handle id, so two songs may never share one. */
function uniqueName(fileName: string, tracks: Track[]): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim() || "song";
  let name = base;
  for (let n = 2; tracks.some((track) => track.name === name); n++) name = `${base} ${n}`;
  return name;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

type Props = BaseNode<Data>;
Music.defaultProps = { data: defaults };
