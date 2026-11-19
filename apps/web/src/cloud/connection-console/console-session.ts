/**
 * What every Connection Console session shares: the selected connection, its
 * transcript, the command grammar, and the observers.
 *
 * A console session is the module behind one configuration page. The page
 * renders its state and hands it what the user did; the session decides what
 * that does. There is one per connection kind (`broker-console-session.ts`,
 * `llm-console-session.ts`), and each is built on the transcript below. No
 * React and no DOM in here, so a session runs in a test as it runs in the page.
 */
import type { ConsoleCommand } from "./completions";

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

/** What a console shows: the shared part, plus what its connection kind adds. */
export type ConsoleState<Extra> = Selection<Extra> & {
  /** The commands `run` understands, with completions for what is known now. */
  readonly commands: ConsoleCommand[];
};

/** A console's state before its commands are derived from it. */
type Selection<Extra> = Extra & {
  /** Empty when there is no connection to select. */
  readonly selectedId: string;
  /** The selected connection's transcript, oldest first. */
  readonly lines: ConsoleLine[];
};

/**
 * The interface of a console session, whatever it talks to.
 *
 * Invariants: `getState` returns the same object until something changes, and
 * `subscribe` listeners are called after every change. Creating a session has
 * no effect outside it; `open` is what starts work on the host.
 */
export type ConsoleSession<Extra> = {
  getState(): ConsoleState<Extra>;
  subscribe(listener: () => void): () => void;
  /**
   * Go live: follow the stored configurations and hold whatever the selected
   * connection needs on the host. The returned function lets all of it go.
   */
  open(): () => void;
  /**
   * Switch connection. The transcript starts empty; nothing carries over.
   * Selecting the connection that is already selected does nothing.
   */
  select(id: string): void;
  /** Run one line the user typed. Never rejects: a failure is a transcript line. */
  run(input: string): Promise<void>;
  /**
   * The user finished filling in the selected connection's endpoint. Counts it
   * as added, once: a connection is created blank and configured in place, so
   * creation alone would report every one with an empty endpoint.
   */
  reportConfigured(): void;
};

const MAX_LINES = 300;

/* ── command grammar ────────────────────────────────────────────────────── */

/**
 * A verb, whitespace-separated tokens, and the raw remainder. The remainder
 * matters — an MQTT payload and an LLM prompt are free text and must survive
 * verbatim, so they are sliced off the original string rather than rebuilt
 * from the tokens.
 */
export type ParsedCommand = {
  /** The whole line, without surrounding whitespace. */
  raw: string;
  /** First word, lowercased. */
  verb: string;
  /** Whitespace-separated words after the verb. */
  tokens: string[];
  /** Everything after the verb, unaltered apart from surrounding whitespace. */
  rest: string;
};

function parseCommand(raw: string): ParsedCommand {
  const verb = raw.split(/\s+/, 1)[0];
  const rest = raw.slice(verb.length).trim();
  return { raw, verb: verb.toLowerCase(), tokens: rest === "" ? [] : rest.split(/\s+/), rest };
}

/**
 * The remainder after the first `count` tokens — `pub some/topic hello  world`
 * keeps its double space in the payload.
 */
export function restAfter(parsed: ParsedCommand, count: number): string {
  let rest = parsed.rest;
  for (const token of parsed.tokens.slice(0, count)) {
    rest = rest.slice(rest.indexOf(token) + token.length);
  }
  return rest.trim();
}

/* ── transcript ─────────────────────────────────────────────────────────── */

type Line = Omit<ConsoleLine, "at">;

/**
 * Where one command's lines go. A command can be answered after the user has
 * switched connection, and a transcript holds its own connection's lines only.
 */
export type Reply = {
  /** Append a line, unless the session has moved on since the command was run. */
  push(line: Line): void;
  /** Whether the session is still on the selection the command was run under. */
  readonly current: boolean;
};

/**
 * The state every session keeps, and the two commands every console has
 * (`clear` and `?`). A connection kind supplies its own state, its vocabulary
 * and what its verbs do.
 */
export function createTranscript<Extra extends object>(init: {
  selectedId: string;
  extra: Extra;
  /** The vocabulary, as "?" lists it. */
  vocabulary: ConsoleCommand[];
  /** The vocabulary with completions for `state`. Derived again on every change. */
  commands: (state: Selection<Extra>) => ConsoleCommand[];
}) {
  const derive = (base: Selection<Extra>): ConsoleState<Extra> => ({
    ...base,
    commands: init.commands(base),
  });

  let state = derive({ ...init.extra, selectedId: init.selectedId, lines: [] });
  const listeners = new Set<() => void>();
  const reported = new Set<string>();
  /** Counts the selections made; a command belongs to the one it was run under. */
  let selection = 0;

  const set = (next: Selection<Extra>) => {
    state = derive(next);
    for (const listener of listeners) listener();
  };

  /** Append a line, keeping the transcript bounded. */
  const push = (line: Line) =>
    set({ ...state, lines: [...state.lines.slice(-(MAX_LINES - 1)), { ...line, at: new Date() }] });

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Change the kind's own state. An empty patch only derives the commands again. */
    update: (patch: Partial<Extra>) => set({ ...state, ...patch }),
    push,
    /** Switch connection: an empty transcript and the kind's state for `id`. */
    select(id: string, extra: Extra) {
      selection++;
      set({ ...extra, selectedId: id, lines: [] });
    },
    /** Disown the commands still on their way, as a switch does, and keep the transcript. */
    abandon() {
      selection++;
    },
    /** Run `report` the first time `id` is seen. */
    reportOnce(id: string, report: () => void) {
      if (reported.has(id)) return;
      reported.add(id);
      report();
    },
    /** Interpret one input line: blank is nothing, `clear` and `?` belong to
     *  every console, and any other verb is the kind's. */
    async run(
      input: string,
      interpret: (parsed: ParsedCommand, reply: Reply) => void | Promise<void>,
    ) {
      const raw = input.trim();
      if (raw === "") return;
      const parsed = parseCommand(raw);
      const ranUnder = selection;
      const reply: Reply = {
        push: (line) => {
          if (ranUnder === selection) push(line);
        },
        get current() {
          return ranUnder === selection;
        },
      };
      switch (parsed.verb) {
        case "clear":
          return set({ ...state, lines: [] });
        case "?":
        case "help":
          return push({ kind: "sys", text: "", table: init.vocabulary });
        default:
          return interpret(parsed, reply);
      }
    },
  };
}
