/**
 * The shared surface behind /configuration/mqtt and /configuration/llm.
 *
 * Both pages are the same job — keep a list of named connections, then poke one
 * of them and watch what comes back — so they are one component: a rail of
 * connections on the left (a fifth broker costs no more attention than the
 * first), a live transcript in the middle, a command bar that teaches itself,
 * and the selected connection's settings in a slide-over on the same surface.
 *
 * Everything here is presentation. Transports, stores and analytics stay in the
 * routes, which pass in connections, a command handler and a settings form.
 */
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  EraserIcon,
  SearchIcon,
  Settings2Icon,
  StarIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/states/empty-state";
import {
  applyCompletion,
  completeCommand,
  tokenizeArgs,
  tokenizeCommand,
  type CommandToken,
  type CommandTokenKind,
  type ConsoleCommand,
  type Suggestion,
} from "./completions";

export type { ConsoleCommand } from "./completions";

/** How a connection is doing, in the only four states a rail dot can show. */
export type ConnectionStatusTone = "ok" | "busy" | "error" | "idle";

export type ConsoleConnection = {
  id: string;
  name: string;
  /** The endpoint, shown under the name. Empty means "not configured yet". */
  subtitle: string;
  status: ConnectionStatusTone;
  isDefault?: boolean;
};

export type ConsoleLine = {
  /** in: received · out: sent · sys: the app talking · err: something failed. */
  kind: "in" | "out" | "sys" | "err";
  /** Topic, model — whatever names the other end of this line. */
  label?: string;
  text: string;
  at: Date;
  /** Renders as an aligned command table instead of `text` — the "?" answer. */
  table?: ConsoleCommand[];
};

/** A starting point offered in the rail's add menu. */
export type ConsolePreset = { id: string; title: string; blurb: string };

const MAX_LINES = 300;

const STATUS_DOT: Record<ConnectionStatusTone, string> = {
  ok: "bg-primary",
  busy: "bg-accent animate-pulse",
  error: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

const STATUS_LABEL: Record<ConnectionStatusTone, string> = {
  ok: "connected",
  busy: "connecting",
  error: "error",
  idle: "idle",
};

/** The console's syntax colours, shared by the input, the hints and the "?"
 *  table so a command looks the same everywhere it appears. */
const TOKEN_CLASS: Record<CommandTokenKind, string> = {
  command: "text-primary",
  unknown: "text-destructive",
  arg: "text-violet-700 dark:text-violet-300",
  text: "text-foreground",
  space: "",
};

function Tokens({ tokens, muted }: { tokens: CommandToken[]; muted?: boolean }) {
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} className={cn(TOKEN_CLASS[token.kind], muted && "opacity-70")}>
          {token.text}
        </span>
      ))}
    </>
  );
}

const LINE_STYLE: Record<ConsoleLine["kind"], { glyph: string; className: string }> = {
  in: { glyph: "←", className: "text-sky-700 dark:text-sky-400" },
  out: { glyph: "→", className: "text-primary" },
  sys: { glyph: "··", className: "text-muted-foreground" },
  err: { glyph: "!!", className: "text-destructive" },
};

/** Append a line, keeping the transcript bounded. */
export function appendLine(lines: ConsoleLine[], line: Omit<ConsoleLine, "at">): ConsoleLine[] {
  return [...lines.slice(-(MAX_LINES - 1)), { ...line, at: new Date() }];
}

export function ConnectionConsole({
  title,
  connections,
  selectedId,
  onSelect,
  addLabel,
  presets,
  onAdd,
  detail,
  lines,
  onClear,
  commands,
  onRun,
  chips,
  placeholder,
  emptyState,
}: {
  /** Rail heading — "mqtt", "llm". */
  title: string;
  connections: ConsoleConnection[];
  selectedId: string;
  onSelect: (id: string) => void;
  addLabel: string;
  /** Offered in the add menu; without them the add button adds a blank entry. */
  presets?: ConsolePreset[];
  onAdd: (presetId?: string) => void;
  /** Settings for the selected connection, rendered in the slide-over. */
  detail: ReactNode;
  lines: ConsoleLine[];
  onClear: () => void;
  commands: ConsoleCommand[];
  onRun: (command: string) => void;
  /** Live state worth keeping in sight: subscriptions, the current model… */
  chips?: ReactNode;
  placeholder: string;
  /** Shown in place of the transcript before anything has happened. */
  emptyState: ReactNode;
}) {
  const [command, setCommand] = useState("");
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState(-1);
  const [suggestionAt, setSuggestionAt] = useState(0);
  /** Escape hides the popup until the next keystroke. */
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const filterId = useId();

  const selected = connections.find((connection) => connection.id === selectedId);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return lines;
    return lines.filter((line) => `${line.label ?? ""} ${line.text}`.toLowerCase().includes(needle));
  }, [lines, filter]);

  // A just-added connection has nothing configured, so its settings are the only
  // useful thing on screen — but only auto-open once, or closing them fights back.
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (!selected || selected.subtitle.trim() !== "" || autoOpened.current.has(selected.id)) return;
    autoOpened.current.add(selected.id);
    setShowSettings(true);
  }, [selected]);

  const submit = () => {
    const value = command.trim();
    if (value === "") return;
    setHistory((previous) => [value, ...previous.filter((entry) => entry !== value)].slice(0, 50));
    setHistoryAt(-1);
    setCommand("");
    setDismissed(false);
    onRun(value);
  };

  const recall = (delta: number) => {
    const next = Math.min(history.length - 1, Math.max(-1, historyAt + delta));
    setHistoryAt(next);
    setCommand(next === -1 ? "" : history[next]);
  };

  /* ── completion, IDE-style: the rules live in ./completions ─────────── */
  const { suggestions, prefix, signature } = useMemo(
    () => (dismissed ? { suggestions: [], prefix: "", signature: "" } : completeCommand(commands, command)),
    [commands, command, dismissed],
  );

  useEffect(() => setSuggestionAt(0), [command]);

  const accept = (suggestion: Suggestion) => {
    setCommand(applyCompletion(command, prefix, suggestion.value));
    inputRef.current?.focus();
  };

  /** Widest value and signature in the popup, in characters. */
  const columnWidths = useMemo(
    () => ({
      value: Math.max(0, ...suggestions.map((entry) => entry.value.length)),
      args: Math.max(0, ...suggestions.map((entry) => entry.args?.length ?? 0)),
    }),
    [suggestions],
  );

  /** Greyed-out text trailing the caret: the rest of the highlighted
   *  completion, or the argument signature once the command is complete. */
  const active = suggestions[suggestionAt];
  const ghost = active ? active.value.slice(prefix.length) : signature;

  return (
    <div className="h-full flex bg-background text-foreground text-[13px]">
      <aside className="w-56 lg:w-64 shrink-0 border-r bg-sidebar flex flex-col">
        <div className="h-11 shrink-0 px-4 flex items-center border-b">
          <span className="text-primary font-medium">{title}</span>
          <span className="ml-auto text-xs text-muted-foreground">{connections.length}</span>
        </div>

        <ul className="flex-1 overflow-auto p-1.5 space-y-0.5">
          {connections.map((connection) => (
            <li key={connection.id}>
              <button
                type="button"
                onClick={() => onSelect(connection.id)}
                aria-current={connection.id === selectedId}
                className={cn(
                  "w-full text-left rounded px-2.5 py-2 flex items-start gap-2.5 transition-colors",
                  connection.id === selectedId
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent/50",
                )}
              >
                <span
                  className={cn("size-2 rounded-full mt-1.5 shrink-0", STATUS_DOT[connection.status])}
                  title={STATUS_LABEL[connection.status]}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate">{connection.name}</span>
                    {connection.isDefault && (
                      <StarIcon className="size-3 shrink-0 text-accent fill-accent" aria-label="default" />
                    )}
                  </span>
                  <span className="block text-[11px] text-muted-foreground truncate">
                    {connection.subtitle || "not configured"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="border-t p-1.5">
          <AddConnection label={addLabel} presets={presets} onAdd={onAdd} />
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-11 shrink-0 border-b px-4 flex items-center gap-3">
          {selected ? (
            <>
              <span className={cn("size-2 rounded-full shrink-0", STATUS_DOT[selected.status])} />
              <span className="truncate">{selected.name}</span>
              <span className="text-muted-foreground truncate hidden sm:block">{selected.subtitle}</span>
            </>
          ) : (
            <span className="text-muted-foreground">no connection selected</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <IconButton label="Filter transcript" active={showFilter} onClick={() => setShowFilter((v) => !v)}>
              <SearchIcon className="size-4" />
            </IconButton>
            <IconButton label="Clear transcript" onClick={onClear} disabled={lines.length === 0}>
              <EraserIcon className="size-4" />
            </IconButton>
            <IconButton
              label="Connection settings"
              active={showSettings}
              disabled={!selected}
              onClick={() => setShowSettings((v) => !v)}
            >
              <Settings2Icon className="size-4" />
            </IconButton>
          </div>
        </div>

        {showFilter && (
          <div className="shrink-0 border-b px-4 py-2 flex items-center gap-2">
            <label htmlFor={filterId} className="sr-only">
              Filter transcript
            </label>
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <input
              id={filterId}
              autoFocus
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="filter transcript"
              className="flex-1 bg-transparent outline-none text-xs placeholder:text-muted-foreground/60"
            />
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {shown.length}/{lines.length}
            </span>
          </div>
        )}

        <div className="flex-1 min-h-0 flex relative">
          {shown.length === 0 ? (
            <div className="flex-1 min-w-0 overflow-auto grid place-items-center p-4">
              {lines.length === 0 ? (
                emptyState
              ) : (
                <EmptyState
                  icon={SearchIcon}
                  title="Nothing matches"
                  description={`No line in the transcript contains "${filter.trim()}".`}
                />
              )}
            </div>
          ) : (
            /* column-reverse pins the scroll to the newest line, which the inner
               wrapper still renders oldest-first: newest ends up at the bottom. */
            <div className="flex-1 min-w-0 overflow-auto p-4 flex flex-col-reverse">
              <div>
                {shown.map((line, index) => {
                  const style = LINE_STYLE[line.kind];
                  return (
                    <div key={index} className="flex gap-3 py-0.5 items-baseline">
                      <time className="text-muted-foreground/70 tabular-nums text-[11px] shrink-0">
                        {line.at.toLocaleTimeString()}
                      </time>
                      <span className={cn("w-5 shrink-0", style.className)} aria-hidden>
                        {style.glyph}
                      </span>
                      {line.table ? (
                        <CommandTable commands={line.table} />
                      ) : (
                        <>
                          {line.label && (
                            <span className="text-violet-700 dark:text-violet-300 shrink-0">
                              {line.label}
                            </span>
                          )}
                          <span
                            className={cn(
                              "whitespace-pre-wrap break-words",
                              line.kind === "err" && "text-destructive",
                            )}
                          >
                            {line.text}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {showSettings && selected && (
            <aside className="w-80 shrink-0 border-l bg-card overflow-auto max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:shadow-lg max-sm:w-full">
              <div className="h-9 px-3 flex items-center border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                Settings
                <button
                  type="button"
                  aria-label="Close settings"
                  className="ml-auto hover:text-foreground"
                  onClick={() => setShowSettings(false)}
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
              <div className="p-3">{detail}</div>
            </aside>
          )}
        </div>

        <div className="shrink-0 border-t">
          {chips && <div className="px-4 pt-2 flex flex-wrap gap-1.5">{chips}</div>}
          <div className="px-4 py-2 flex flex-wrap gap-1.5">
            {commands.map((entry) => (
              <button
                key={entry.name}
                type="button"
                title={entry.help}
                onClick={() => {
                  setCommand(entry.insert ?? `${entry.name} `);
                  inputRef.current?.focus();
                }}
                className="rounded border px-2 py-0.5 text-[11px] hover:border-foreground/40"
              >
                <span className="text-primary">{entry.name}</span>
                {entry.args && (
                  <span className="whitespace-pre">
                    {" "}
                    <Tokens tokens={tokenizeArgs(entry)} muted />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="relative">
            {suggestions.length > 0 && (
              <ul className="absolute bottom-full left-4 right-4 mb-1 z-10 max-h-56 overflow-auto rounded border bg-popover shadow-lg py-1">
                {suggestions.map((suggestion, index) => (
                  <li key={suggestion.value}>
                    <button
                      type="button"
                      // The input must keep focus, so complete on mousedown
                      // before the blur ever happens.
                      onMouseDown={(event) => {
                        event.preventDefault();
                        accept(suggestion);
                      }}
                      onMouseEnter={() => setSuggestionAt(index)}
                      className={cn(
                        "w-full text-left px-3 py-1 flex items-baseline gap-3",
                        index === suggestionAt ? "bg-accent/15" : "hover:bg-accent/10",
                      )}
                    >
                      {/* Mono type, so a ch-width column aligns every row. */}
                      <span className={TOKEN_CLASS.command} style={{ minWidth: `${columnWidths.value}ch` }}>
                        {suggestion.value}
                      </span>
                      {columnWidths.args > 0 && (
                        <span className="whitespace-pre" style={{ minWidth: `${columnWidths.args}ch` }}>
                          <Tokens tokens={tokenizeArgs({ name: "", help: "", args: suggestion.args })} />
                        </span>
                      )}
                      {suggestion.detail && (
                        <span className="text-[11px] text-muted-foreground truncate">{suggestion.detail}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="px-4 h-12 flex items-center gap-2 border-t">
              <span className={cn("shrink-0", selected ? "text-primary" : "text-muted-foreground/50")} aria-hidden>
                ❯
              </span>
              {/* The whole app is set in a mono face, so the coloured overlay
                  lines up with the transparent input, character for character.
                  It follows the input's own scroll so a long line stays in sync. */}
              <div className="relative flex-1 min-w-0 overflow-hidden">
                <div
                  aria-hidden
                  ref={overlayRef}
                  className="pointer-events-none absolute inset-0 flex items-center whitespace-pre"
                >
                  <Tokens tokens={tokenizeCommand(commands, command)} />
                  <span className="text-muted-foreground/50">{ghost}</span>
                </div>
                <input
                  ref={inputRef}
                  value={command}
                  disabled={!selected}
                  aria-label={`Command for ${selected?.name ?? "connection"}`}
                  aria-autocomplete="list"
                  aria-expanded={suggestions.length > 0}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setCommand(event.target.value);
                    setDismissed(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") return submit();
                    if (event.key === "Tab" && suggestions[suggestionAt]) {
                      event.preventDefault();
                      return accept(suggestions[suggestionAt]);
                    }
                    if (event.key === "Escape") return setDismissed(true);
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      const down = event.key === "ArrowDown";
                      // The popup owns the arrows while it is open; history
                      // takes them back the moment it closes.
                      if (suggestions.length > 0) {
                        return setSuggestionAt(
                          (suggestionAt + (down ? 1 : -1) + suggestions.length) % suggestions.length,
                        );
                      }
                      return recall(down ? -1 : 1);
                    }
                  }}
                  onScroll={(event) => {
                    if (overlayRef.current) {
                      overlayRef.current.style.transform = `translateX(-${event.currentTarget.scrollLeft}px)`;
                    }
                  }}
                  placeholder={selected ? placeholder : `add a ${addLabel} first`}
                  className="w-full bg-transparent text-transparent caret-foreground selection:bg-primary/30 outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
                />
              </div>
              <span className="text-[11px] text-muted-foreground hidden md:block">
                {suggestions.length > 0 ? "⇥ complete · ↑↓ pick" : "↑ history · ? help"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The "?" answer: every command, its signature and its help in three columns. */
function CommandTable({ commands }: { commands: ConsoleCommand[] }) {
  return (
    <div className="grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-0.5 min-w-0">
      {commands.map((command) => (
        <Fragment key={command.name}>
          <span className={TOKEN_CLASS.command}>{command.name}</span>
          <span className="whitespace-pre">
            <Tokens tokens={tokenizeArgs(command)} />
          </span>
          <span className="text-muted-foreground">{command.help}</span>
        </Fragment>
      ))}
    </div>
  );
}

function IconButton({
  children,
  label,
  onClick,
  active,
  disabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/10 disabled:opacity-30 disabled:hover:bg-transparent",
        active && "text-primary bg-primary/10",
      )}
    >
      {children}
    </button>
  );
}

function AddConnection({
  label,
  presets,
  onAdd,
}: {
  label: string;
  presets?: ConsolePreset[];
  onAdd: (presetId?: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!presets?.length) {
    return (
      <Button variant="ghost" size="sm" className="w-full justify-start font-normal" onClick={() => onAdd()}>
        + {label}
      </Button>
    );
  }

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start font-normal"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        + {label}
        <ChevronDownIcon className={cn("size-3.5 ml-auto transition-transform", open && "rotate-180")} />
      </Button>
      {open && (
        <div className="mt-1 space-y-0.5">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                onAdd(preset.id);
                setOpen(false);
              }}
              className="w-full rounded px-2.5 py-1.5 text-left hover:bg-sidebar-accent"
            >
              <span className="text-xs">{preset.title}</span>
              <span className="block text-[11px] text-muted-foreground leading-snug">{preset.blurb}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A labelled field for the settings slide-over. */
export function ConsoleField({
  label,
  hint,
  tone,
  ...props
}: { label: string; hint?: ReactNode; tone?: "warning" } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="space-y-1 mb-3">
      <label htmlFor={id} className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        {...props}
        className="w-full rounded border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-ring placeholder:text-muted-foreground/60"
      />
      {hint && (
        <p
          className={cn(
            "text-[11px] leading-snug",
            tone === "warning" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
          )}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/** A pill of live state above the command bar. */
export function ConsoleChip({ children, onRemove, removeLabel }: {
  children: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">
      {children}
      {onRemove && (
        <button type="button" aria-label={removeLabel} onClick={onRemove} className="hover:text-destructive">
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}
