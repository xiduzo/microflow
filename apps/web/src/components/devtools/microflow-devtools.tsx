import { useMemo, useState } from "react";
import { ActivityIcon, PauseIcon, PlayIcon, Trash2Icon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useDevLogStore, type DevLogLevel } from "@/stores/dev-log";
import { useUiPanelStore } from "@/stores/ui-panel";

/** Cap rows actually rendered; the store keeps a deeper history. */
const VISIBLE_LIMIT = 500;

const LEVEL_COLOR: Record<DevLogLevel, string> = {
  error: "text-red-500",
  warn: "text-amber-500",
  info: "text-sky-400",
  debug: "text-emerald-400",
  trace: "text-muted-foreground",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * App-wide Microflow devtools — a TanStack-style bottom drawer that streams the
 * whole app's activity: backend `log::` records (hardware, MQTT, LLM) plus flow
 * execution events, all through the unified `useDevLogStore`. Launched from a
 * floating button (bottom-left, clear of the TanStack devtools at bottom-right).
 */
export function MicroflowDevtools() {
  const open = useUiPanelStore((state) => state.devtoolsOpen);
  const setOpen = useUiPanelStore((state) => state.setDevtoolsOpen);

  // Deliberately subscribes to nothing but `devtoolsOpen`. The log subscription
  // lives in `DevtoolsPanel` below, which only mounts while the drawer is open —
  // otherwise this component re-rendered on every flow event to draw a static
  // launcher button, for the whole life of the app.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open Microflow devtools"
        className="bg-background/90 border-border text-muted-foreground hover:text-foreground fixed right-4 bottom-16 z-50 flex size-9 items-center justify-center rounded-full border shadow-md backdrop-blur transition-colors"
      >
        <ActivityIcon className="size-4" />
      </button>
    );
  }

  return <DevtoolsPanel onClose={() => setOpen(false)} />;
}

/** The open drawer. Mounted only while open, so it is the only thing in the app
 *  that re-renders as the dev log fills. */
function DevtoolsPanel({ onClose }: { onClose: () => void }) {
  const entries = useDevLogStore((state) => state.entries);
  const paused = useDevLogStore((state) => state.paused);
  const setPaused = useDevLogStore((state) => state.setPaused);
  const clear = useDevLogStore((state) => state.clear);
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return entries.slice(0, VISIBLE_LIMIT);
    // Stop scanning once the visible window is full — a 1000-entry history only
    // ever shows `VISIBLE_LIMIT` rows, so filtering the whole array was work
    // thrown away on every keystroke and every flush.
    const matched: typeof entries = [];
    for (const entry of entries) {
      if (matched.length >= VISIBLE_LIMIT) break;
      if (
        entry.source.toLowerCase().includes(query) ||
        entry.message.toLowerCase().includes(query)
      ) {
        matched.push(entry);
      }
    }
    return matched;
  }, [entries, filter]);

  return (
    <div className="bg-background/95 border-border fixed inset-x-0 bottom-0 z-50 flex h-[45vh] flex-col border-t shadow-2xl backdrop-blur">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <ActivityIcon className="text-primary size-4 shrink-0" />
        <span className="text-sm font-semibold">Microflow devtools</span>
        <span className="text-muted-foreground tabular-nums text-xs">{entries.length} events</span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by source or message…"
          className="bg-muted/40 placeholder:text-muted-foreground focus-visible:ring-ring/50 ml-auto w-72 rounded-sm px-2 py-1 text-xs outline-none focus-visible:ring-1"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setPaused(!paused)}
          aria-label={paused ? "Resume" : "Pause"}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={clear} aria-label="Clear">
          <Trash2Icon />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <XIcon />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {visible.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center text-sm">
            {entries.length === 0 ? "No activity yet." : "Nothing matches the filter."}
          </div>
        ) : (
          <div className="flex flex-col py-1">
            {visible.map((entry) => (
              <div
                key={entry.id}
                className="hover:bg-muted/40 border-border/30 flex items-baseline gap-3 border-b px-4 py-1 font-mono text-xs leading-relaxed"
              >
                <span className="text-muted-foreground w-[6rem] shrink-0 tabular-nums">
                  {formatTime(entry.timestamp)}
                </span>
                <span
                  className={cn(
                    "w-12 shrink-0 font-semibold uppercase",
                    LEVEL_COLOR[entry.level],
                  )}
                >
                  {entry.level}
                </span>
                <span className="text-primary/90 w-28 shrink-0 truncate" title={entry.source}>
                  {entry.source}
                </span>
                <span
                  className="text-foreground min-w-0 flex-1 break-words whitespace-pre-wrap"
                  title={entry.message}
                >
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
