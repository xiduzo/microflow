// The MQTT broker settings, and the one place they settle.
//
// The settings form writes a field at every keystroke, and most prefixes of a
// URL being typed are URLs a connection can be opened to. So what is typed is
// kept apart (`unsettled`) from what every connection is made from (`brokers`),
// and joins it once the typing has stopped: `BROKER_SETTINGS_SETTLE_MS` after
// the last keystroke for that broker, or when something asks for it sooner
// (`settleBrokerSettings`). Whatever connects reads `brokers` and so sees a
// change once: the desktop host's broker sync, a flow update, the browser
// CloudPerformer, the status probe, the Connection Console's link. Only the
// form reads what is being typed (`useBrokerSettingsForm`).
//
// A broker that is added or removed, and another default broker, are not
// typing: they are in `brokers` at once.

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { BrokerConn } from "./mqtt-client";
import { realTimers, type Timers } from "@/lib/timers";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type MqttBrokerConfig = {
  id: string;
  name: string;
  url: string;
  username?: string;
  password?: string;
  isDefault: boolean;
};

/** The fields of a broker the settings form edits. */
export type BrokerFields = Partial<Omit<MqttBrokerConfig, "id">>;

/**
 * How long a broker's settings must have gone unedited before they settle.
 *
 * Half a second is longer than the gap between two keystrokes of somebody
 * typing or correcting a URL (a slow typist leaves 200 to 300 ms), so a URL
 * typed in one go is connected to once; and it is short enough that the
 * broker's status answers as the hands leave the keyboard. It is also the wait
 * of a flow update (`use-flow-update-dispatcher.ts`), so an edited flow and
 * edited settings reach the runtime in the same beat. A pause longer than this
 * settles what was typed so far.
 */
export const BROKER_SETTINGS_SETTLE_MS = 500;

type MqttBrokerStore = {
  /** The settled broker settings: what every connection is made from. */
  brokers: MqttBrokerConfig[];
  /** What the settings form holds that has not settled: per broker id, the
   *  fields typed since its settings last settled. Only the form reads this
   *  ({@link brokerSettingsForm}). */
  unsettled: Record<string, BrokerFields>;
  /** Connection status per broker ID (managed separately from persisted config) */
  statuses: Record<string, ConnectionStatus>;
  /** Per broker ID, why its status is `error`, when the host knows something
   *  the user can act on (`mqtt-refusal.ts`). A broker without one has none. */
  problems: Record<string, string>;
  /** Settled at once. */
  addBroker: (broker: Omit<MqttBrokerConfig, "id">) => string;
  /** What the settings form does at a keystroke: `fields` are shown by the
   *  form at once and settle {@link BROKER_SETTINGS_SETTLE_MS} after the last
   *  call for this broker. For a broker that is not there, nothing happens. */
  updateBroker: (id: string, fields: BrokerFields) => void;
  /** Settled at once. What was typed for the broker goes with it. */
  deleteBroker: (id: string) => void;
  /** Settled at once. */
  setDefaultBroker: (id: string) => void;
  /** Settle what is typed now, without waiting: for one broker, or for all of
   *  them in one change. Nothing changes when nothing is typed. */
  settle: (id?: string) => void;
  getDefaultBroker: () => MqttBrokerConfig | undefined;
  getBroker: (id: string) => MqttBrokerConfig | undefined;
  /** The broker's status, and why it is that: `problem`, or nothing known. */
  setStatus: (id: string, status: ConnectionStatus, problem?: string) => void;
  /** Every broker's status, and the problems of those that have one: what
   *  the store held before is replaced. */
  setStatuses: (statuses: Record<string, ConnectionStatus>, problems?: Record<string, string>) => void;
};

/** `problems` with `problem` as broker `id`'s, or without one for it. */
function withProblem(
  problems: Record<string, string>,
  id: string,
  problem: string | undefined,
): Record<string, string> {
  if (problems[id] === problem) return problems;
  const { [id]: _was, ...rest } = problems;
  return problem === undefined ? rest : { ...rest, [id]: problem };
}

const uid = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

/** `broker` with `fields` written over it; `broker` itself when they change nothing. */
function withFields(broker: MqttBrokerConfig, fields: BrokerFields | undefined): MqttBrokerConfig {
  if (!fields) return broker;
  const typed = { ...broker, ...fields };
  const same = (Object.keys(typed) as Array<keyof MqttBrokerConfig>).every(
    (field) => typed[field] === broker[field],
  );
  return same ? broker : typed;
}

/** `brokers` with what is typed for each; `brokers` itself when that changes nothing. */
function asTyped(
  brokers: MqttBrokerConfig[],
  unsettled: Record<string, BrokerFields>,
): MqttBrokerConfig[] {
  const typed = brokers.map((broker) => withFields(broker, unsettled[broker.id]));
  return typed.every((broker, index) => broker === brokers[index]) ? brokers : typed;
}

/** Whether a connection to `is` is another one than a connection to `was`. */
const connectsDifferently = (was: MqttBrokerConfig, is: MqttBrokerConfig): boolean =>
  was.url !== is.url || was.username !== is.username || was.password !== is.password;

/**
 * A store of broker settings. The app has one ({@link useMqttBrokerStore}).
 *
 * `timers` is what the settle wait runs on, and `storage` where the settings
 * are kept: `setTimeout` and `localStorage` when left out. A test passes
 * virtual time and a storage of its own.
 *
 * The storage holds the settings as typed, from the keystroke on, so closing
 * the app loses nothing; a store that loads them starts with them settled.
 */
export function createMqttBrokerStore(options: { timers?: Timers; storage?: StateStorage } = {}) {
  const timers = options.timers ?? realTimers;
  const { storage } = options;
  /** The settle wait of each broker that has something typed. */
  const waits = new Map<string, unknown>();
  const endWait = (id: string) => {
    if (!waits.has(id)) return;
    timers.clear(waits.get(id));
    waits.delete(id);
  };

  return create<MqttBrokerStore>()(
    persist(
      (set, get) => ({
        brokers: [],
        unsettled: {},
        statuses: {},
        problems: {},

        addBroker: (broker) => {
          const id = uid();
          const isFirst = get().brokers.length === 0;
          set((state) => ({
            brokers: [
              ...state.brokers,
              { ...broker, id, isDefault: isFirst || broker.isDefault },
            ],
          }));
          return id;
        },

        updateBroker: (id, fields) => {
          if (!get().brokers.some((broker) => broker.id === id)) return;
          set((state) => ({
            unsettled: { ...state.unsettled, [id]: { ...state.unsettled[id], ...fields } },
          }));
          endWait(id);
          waits.set(
            id,
            timers.set(() => get().settle(id), BROKER_SETTINGS_SETTLE_MS),
          );
        },

        settle: (id) => {
          const ids = id === undefined ? Object.keys(get().unsettled) : [id];
          for (const each of ids) endWait(each);
          set((state) => {
            const settling: Record<string, BrokerFields> = {};
            const unsettled: Record<string, BrokerFields> = {};
            for (const [each, fields] of Object.entries(state.unsettled)) {
              (ids.includes(each) ? settling : unsettled)[each] = fields;
            }
            if (Object.keys(settling).length === 0) return state;
            // The same list when what was typed changes nothing: nobody that
            // follows the settings is told.
            const brokers = asTyped(state.brokers, settling);
            // The status held for a broker is that of the connection it had.
            // With other settings it is being connected to anew, and stays
            // `connecting` until the host reports on that.
            const statuses = { ...state.statuses };
            let { problems } = state;
            state.brokers.forEach((was, index) => {
              const is = brokers[index];
              if (is && connectsDifferently(was, is)) {
                statuses[was.id] = "connecting";
                problems = withProblem(problems, was.id, undefined);
              }
            });
            return { brokers, unsettled, statuses, problems };
          });
        },

        deleteBroker: (id) => {
          endWait(id);
          set((state) => {
            const filtered = state.brokers.filter((b) => b.id !== id);
            // If we deleted the default, make the first one default
            if (filtered.length > 0 && !filtered.some((b) => b.isDefault)) {
              filtered[0].isDefault = true;
            }
            // Its status and what was typed for it go with it: a wait that
            // ended late would have nothing to bring back.
            const { [id]: _status, ...remainingStatuses } = state.statuses;
            const { [id]: _typed, ...unsettled } = state.unsettled;
            return {
              brokers: filtered,
              unsettled,
              statuses: remainingStatuses,
              problems: withProblem(state.problems, id, undefined),
            };
          });
        },

        setDefaultBroker: (id) => {
          set((state) => ({
            brokers: state.brokers.map((b) => ({
              ...b,
              isDefault: b.id === id,
            })),
          }));
        },

        getDefaultBroker: () => {
          return get().brokers.find((b) => b.isDefault);
        },

        getBroker: (id) => {
          return get().brokers.find((b) => b.id === id);
        },

        setStatus: (id, status, problem) => {
          set((state) => ({
            statuses: { ...state.statuses, [id]: status },
            problems: withProblem(state.problems, id, problem),
          }));
        },

        setStatuses: (statuses, problems = {}) => {
          set({ statuses, problems });
        },
      }),
      {
        name: "microflow-mqtt-brokers",
        ...(storage ? { storage: createJSONStorage(() => storage) } : {}),
        // The brokers as typed, not the statuses: what is on screen is what a
        // reload brings back, settled.
        partialize: (state) => ({ brokers: asTyped(state.brokers, state.unsettled) }),
      },
    ),
  );
}

export const useMqttBrokerStore = createMqttBrokerStore();

/** Settle the broker settings that are typed now, all of them in one change:
 *  for whatever must not act on older settings than the form shows (a flow
 *  update, a console command, the form being left). */
export function settleBrokerSettings(): void {
  useMqttBrokerStore.getState().settle();
}

/** The broker settings as the settings form shows them. */
export type BrokerSettingsForm = {
  /** The brokers with what is typed for each. */
  brokers: MqttBrokerConfig[];
  /** The status dot of each broker. A broker whose URL, username or password
   *  is typed and has not settled is `connecting`: the status the store holds
   *  is that of the connection made from the settled settings, not of the
   *  ones on screen, and a connection to those is about to be tried. */
  statuses: Record<string, ConnectionStatus>;
  /** Why a broker's status is `error`, for the brokers whose status shows
   *  one ({@link MqttBrokerStore.problems}): none for a broker that shows
   *  `connecting` because of what is typed. */
  problems: Record<string, string>;
};

/** What the settings form shows of `state`. */
export function brokerSettingsForm(
  state: Pick<MqttBrokerStore, "brokers" | "unsettled" | "statuses"> &
    Partial<Pick<MqttBrokerStore, "problems">>,
): BrokerSettingsForm {
  const brokers = asTyped(state.brokers, state.unsettled);
  const statuses = { ...state.statuses };
  let problems = state.problems ?? {};
  state.brokers.forEach((settled, index) => {
    const typed = brokers[index];
    if (typed && connectsDifferently(settled, typed)) {
      statuses[settled.id] = "connecting";
      problems = withProblem(problems, settled.id, undefined);
    }
  });
  return { brokers, statuses, problems };
}

/** Call `onHidden` when the page is hidden or left. Returns a cleanup. */
function onPageHidden(onHidden: () => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  const hidden = () => {
    if (document.visibilityState === "hidden") onHidden();
  };
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("pagehide", onHidden);
  return () => {
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("pagehide", onHidden);
  };
}

/**
 * The settings form is open from this call until the returned function is
 * called. What is typed and has not settled is settled when the form closes
 * and whenever the page is hidden or left, where a timer may not run: nothing
 * typed stays behind in a form nobody looks at.
 *
 * `watchPage` is the page's own events; a test passes its own.
 */
export function holdBrokerSettingsForm(
  watchPage: (onHidden: () => void) => () => void = onPageHidden,
): () => void {
  const unwatch = watchPage(settleBrokerSettings);
  return () => {
    unwatch();
    settleBrokerSettings();
  };
}

/** {@link brokerSettingsForm} of the app's store, for the settings form: the
 *  form is held open ({@link holdBrokerSettingsForm}) while it is mounted. */
export function useBrokerSettingsForm(): BrokerSettingsForm {
  const brokers = useMqttBrokerStore((state) => state.brokers);
  const unsettled = useMqttBrokerStore((state) => state.unsettled);
  const statuses = useMqttBrokerStore((state) => state.statuses);
  const problems = useMqttBrokerStore((state) => state.problems);
  useEffect(() => holdBrokerSettingsForm(), []);
  return useMemo(
    () => brokerSettingsForm({ brokers, unsettled, statuses, problems }),
    [brokers, unsettled, statuses, problems],
  );
}

/**
 * The connection half of the stored broker `id`, as it has settled: what the
 * browser CloudPerformer resolves a `brokerId` to (`CloudDeps.resolveBroker`).
 */
export function resolveStoredBroker(id: string): BrokerConn | undefined {
  const broker = useMqttBrokerStore.getState().getBroker(id);
  return broker
    ? { id: broker.id, url: broker.url, username: broker.username, password: broker.password }
    : undefined;
}

/**
 * Call `onChange` with the ids of the brokers whose settled connection
 * settings changed (`CloudDeps.watchBrokers`): a broker added or deleted, or a
 * URL, username or password that was typed and has settled. A new name,
 * another default broker or a status dot that changes is not a change to how
 * a broker is connected to, and neither is a keystroke. Returns a cleanup.
 */
export function onBrokerSettingsChange(
  onChange: (brokerIds: readonly string[]) => void,
): () => void {
  let last = useMqttBrokerStore.getState().brokers;
  return useMqttBrokerStore.subscribe((state) => {
    // The broker list keeps its reference across a status write and a keystroke.
    if (state.brokers === last) return;
    const changed = changedConnections(last, state.brokers);
    last = state.brokers;
    if (changed.length > 0) onChange(changed);
  });
}

/** The ids of the brokers that are connected to differently in `next` than in
 *  `previous`, or are in only one of the two. */
function changedConnections(previous: MqttBrokerConfig[], next: MqttBrokerConfig[]): string[] {
  const before = new Map(previous.map((broker) => [broker.id, broker] as const));
  const after = new Map(next.map((broker) => [broker.id, broker] as const));
  return [...new Set([...before.keys(), ...after.keys()])].filter((id) => {
    const was = before.get(id);
    const is = after.get(id);
    if (!was || !is) return true;
    return connectsDifferently(was, is);
  });
}

/**
 * Get the connection status for a specific broker
 */
export function useBrokerStatus(brokerId: string): ConnectionStatus {
  return useMqttBrokerStore((s) => s.statuses[brokerId] ?? "disconnected");
}
