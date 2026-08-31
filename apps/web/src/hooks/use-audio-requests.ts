import { useEffect, useRef } from "react";
import type { CloudRequest } from "@/lib/bindings/CloudRequest";
import { AudioPerformer, audioSourcesOf } from "@/lib/audio/audio-performer";
import { dispatchPort } from "@/lib/firmata/dispatch-port";
import { useListen } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import { useFlowSession } from "@/session";

/**
 * Plays the `Music` node's audio on desktop. The Rust actor cannot play a sound
 * (and the app is a browser anyway), so it forwards the runtime's
 * `AudioPlay`/`AudioStop` cloud requests as an `audio-request` event and this
 * hook drives the same {@link AudioPerformer} the browser reactor owns.
 *
 * The audio files never cross IPC: the request carries the node id and a record
 * index, and the source (`data.tracks[i].src`, a data URL) is read from the
 * session document here. A finished record dispatches `stop` back on the node —
 * the same port a wire drives — so its value falls to false.
 *
 * Browser-side wiring lives in `flow-reactor.ts`; this hook is inert off-desktop.
 * Mounted inside a `FlowSessionProvider`.
 */
export function useAudioRequests() {
  const { doc } = useFlowSession();
  const performerRef = useRef<AudioPerformer | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    const performer = new AudioPerformer(
      (nodeId, track) => {
        const data = doc.getNode(nodeId)?.data;
        return data ? audioSourcesOf(data)[track] : undefined;
      },
      (nodeId) => {
        dispatchPort(nodeId, "stop", false);
      },
    );
    performerRef.current = performer;
    // A deleted Music node must not keep playing — the runtime drops the
    // component silently, so the document is what tells us it is gone.
    const stopVanished = doc.onNodesChange(() => {
      performer.retain(new Set(doc.getNodes().map((node) => node.id)));
    });
    return () => {
      stopVanished();
      performer.dispose();
      performerRef.current = null;
    };
  }, [doc]);

  useListen<CloudRequest>({
    type: "audio-request",
    handler: ({ payload }) => {
      if (payload.kind === "audioPlay") {
        performerRef.current?.play(payload.source, payload.track, payload.volume, payload.loop);
      } else if (payload.kind === "audioStop") {
        performerRef.current?.stop(payload.source);
      }
    },
  });
}
