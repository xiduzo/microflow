// The browser cloud performer: the cloud half of the flow host, lifted out of the
// FlowReactor god-object (ADR-0009).
//
// Mirrors the desktop `CloudPerformer` (apps/web/src-tauri/src/runtime/cloud_performer.rs):
// it performs the cloud `Effects` a turn records — `mqttPublish` and `llmGenerate`
// — and reconciles the runtime's subscriber wirings into live MQTT-over-WSS
// subscriptions (incl. the Figma handshake). Like its desktop twin it is
// **host-free**: it never touches the wasm runtime, the board connection, or any
// Zustand store directly. The two re-entry points back into the runtime (an LLM
// result, an inbound broker message) arrive as injected callbacks — the browser
// analog of the desktop's `ActorMsg::Inject` / `ActorMsg::Deliver` channel sends.
// That makes it unit-testable with a stub `MqttClientFactory`, a stubbed `fetch`,
// and fake resolvers — no broker, no runtime (see `cloud-performer.test.ts`).
//
// **The live set mirrors the brokers.** `reconcile` records what the flow wants;
// a subscription is live only once its broker accepted it, and stops being live
// when the broker refuses it or its connection is replaced. Whatever is wanted
// and not live — no broker configured, a half-typed URL, a link that is down, a
// refused topic — is asked for again by the next `reconcile`, and by the broker
// connection each time it connects.
//
// **The broker settings drive the retries.** The performer keeps what the flow
// wants and watches the broker settings (`CloudDeps.watchBrokers`). When a
// broker's settings change — corrected, added, removed — its connection is
// made to follow them at once and is asked for what the flow wants on it.
// Nothing has to send the flow again (the editor does not re-send an unchanged
// one), as on the desktop, where the broker pool's change signal does the same.
//
// The settings it is given are settled ones: what is typed into the settings
// form reaches `resolveBroker` and `watchBrokers` only once the typing has
// stopped (`cloud/mqtt-broker.ts`, the one settle point of both hosts). So a
// URL that is typed in one go is connected to once, and until then a publish
// and a `reconcile` find the broker's settings, and so its connection, as they
// were. After a pause in the typing the performer connects to what was typed
// so far, with the broker's stored credentials. Should that be a broker, what
// the flow wants is subscribed there and a Bridge ID announced, and taken back
// (`sayGoodbye`) when the URL is typed on.
//
// **Subscribe before announce.** The design-tool handshake follows the live
// set, not the wanted one: a Bridge ID is announced once a subscription is in
// place to catch the plugins' answer, and is never announced for a subscription
// that did not happen.
//
// **Say goodbye before leaving.** A broker connection that is replaced (its
// settings changed), closed (the broker was removed) or disposed first tells
// the plugins Studio is gone, for every Bridge ID announced on it, so no broker
// keeps a retained `connected` for a Studio that left. A connection whose link
// is down cannot be told. What the goodbye says is asked of the policy when a
// Bridge ID is announced, not when the connection closes: a goodbye is also
// said when the flow engine the policy runs in has died (an engine fault), and
// a dead engine is asked for nothing. Where a Bridge ID is announced is recorded only after
// the publish that says so was handed to a connection, or when none can be
// sent, so whatever closes a connection still knows what to take back on it.
// The announce itself publishes on the connections as they are; only `reach`
// opens, replaces or closes one.
//
// **The first goodbye is the link's will.** A tab that crashes or is killed,
// a network that goes, a page frozen past the keep-alive says no goodbye. So
// the first of the goodbyes a broker is to hear (`farewells`) is left with it
// as the will of the connection's links (`BrokerConnections.setWill`), and the
// broker publishes it when a link ends without a DISCONNECT. A goodbye said on
// purpose ends with a DISCONNECT, which drops the will. MQTT gives a link one
// will: with several Bridge IDs on one broker, only the first (in uid order)
// is covered. The desktop host leaves the same will (`set_last_words`).
//
// **Every new link is told again.** A Bridge ID is announced again on its
// broker, `connected` and the variables request, once a new link of the
// broker's connection holds one of its topics: the link before it may have
// ended without a goodbye, so the broker published the will, a broker that
// restarted forgets a retained status it did not persist, and what the
// plugins sent while the link was down never reached Studio. A link renewed
// for a will is not a new one. The desktop host does the same (`Said::link`).
//
// **A connection lasts as long as the flow uses its broker.** A broker is in
// use while the flow wants a topic on it, and for `BROKER_IDLE_MS` after
// something was published on it. `reconcile` is given subscriptions, not the
// brokers a flow's publishing nodes refer to, so a broker that is only
// published to counts as used for as long as publishes keep coming. A broker
// the flow stops subscribing on is reached once the announce has said
// `disconnected` there for the Bridge IDs that left: without another use its
// connection closes, so the wire ends UNSUBSCRIBE, `disconnected`, DISCONNECT,
// whether the node went alone or with its broker's settings. From then on an
// edit to that broker's settings causes no traffic, like an edit to a broker
// the flow never used.
//
// **A flow's publish is for now; a status publish waits.** What becomes of a
// publish whose broker's link is down depends on what it is:
//
// - A flow's publish (`mqttPublish`: the Mqtt node, a design variable's new
//   value) is sent on a link that is up and dropped on one that is down. A
//   minute of LED commands replayed when a broker comes back is worse than
//   none, and nothing piles up for a broker that stays away. The desktop host
//   does the same: its publish fails on a broker that is not connected.
//   One exception: a publish opens its broker's connection, and the publishes
//   made until that connection is up, for `OPENING_PUBLISH_MS` at most, are
//   sent when it is. The desktop host has no such moment: its broker pool
//   connects before a flow publishes.
// - A status publish (the handshake's `connected`, variables request and
//   `disconnected`) is handed to the connection whatever its link: `mqtt.js`
//   stores it and sends it when the link is back, so a Bridge ID that left a
//   broker during an outage is still taken back there. A connection that is
//   closed while its link is down takes what it stored with it; one that has
//   a `disconnected` stored and no other use is kept for `BROKER_IDLE_MS` for
//   the link to return. The desktop host keeps the `disconnected` it owes an
//   offline broker until the link is back or the session ends, and announces
//   an arrival on an online broker only.

import type { CloudRequest } from "@/runtime/effects-sink";
import type { LlmProviderConn } from "@/ai/llm-client";
import { LlmPerformer } from "@/ai/llm-performer";
import { isBrowserReachableBroker } from "./broker-url";
import {
  BrokerConnections,
  defaultMqttClientFactory,
  type BrokerConn,
  type MqttClientFactory,
  type Published,
  type Will,
} from "./mqtt-client";
import {
  diffSubscriptions,
  subKey,
  uidBrokers,
  type ActiveSub,
} from "./mqtt-subscriptions";
import { realTimers, type Timers } from "@/lib/timers";
import { isTopicName } from "./topic-filter";

/**
 * Host-supplied resolvers the performer needs to perform cloud requests (ADR-0009).
 * Keeps it decoupled from the Zustand stores: the board controller passes thin
 * lookups so the performer never imports app state directly.
 */
export type CloudDeps = {
  /** Resolve a `providerId` (from an `llmGenerate` request) to its connection. */
  resolveLlmProvider: (providerId: string) => LlmProviderConn | undefined;
  /** Resolve a `brokerId` (from an `mqttPublish` request or subscriber wiring) to
   *  its WSS connection, as its settings have settled: not what is being typed
   *  into the settings form. It is asked on every publish and every
   *  `reconcile`, and when `watchBrokers` reported the broker; a broker's
   *  connection follows what it returns, at once. */
  resolveBroker: (brokerId: string) => BrokerConn | undefined;
  /** Call `onChange` with the ids of the brokers whose settled connection
   *  settings changed: added, changed or removed, so that `resolveBroker` no
   *  longer returns what it did. Returns a cleanup. The browser's stand-in for
   *  the desktop broker pool's change signal; without it a connection follows
   *  its settings only at a publish or a `reconcile`. */
  watchBrokers?: (onChange: (brokerIds: readonly string[]) => void) => () => void;
  /** The timers the performer's waits run on: how long a broker stays in use
   *  after a publish ({@link BROKER_IDLE_MS}) and the waits of its broker
   *  connections. `setTimeout` when left out. A test passes virtual time. */
  timers?: Timers;
  /** Optional UI feed for inbound broker messages (e.g. the Figma store),
   *  mirroring the desktop "mqtt-message" event. `nodeId` is set for routed
   *  (plain/topicAware) messages, omitted for display-echo. */
  onMqttMessage?: (topic: string, payload: Uint8Array, nodeId?: string) => void;
};

/**
 * How long a broker the flow wants no topic on keeps its connection after the
 * last publish on it. A flow that publishes more often than this keeps one
 * connection; a broker the flow stopped using is let go of after it.
 */
export const BROKER_IDLE_MS = 60_000;

/** One-shot timers, as {@link CloudDeps.timers} takes them. */
export type { Timers };

/** What opens the broker connections: `mqtt.js` unless a test passes another,
 *  and the will each link it opens carries. */
export type { MqttClientFactory, Will };

/** Re-enter an LLM result on the issuing node's handle — the host's
 *  `FlowRuntime.injectEvent` path. Mirrors the desktop `ActorMsg::Inject`. */
export type ResultInjector = (source: string, handle: string, value: unknown) => void;
/** Route an inbound broker message to a subscribe node — the host's
 *  `FlowRuntime.deliverMessage` path. Mirrors the desktop `ActorMsg::Deliver`. */
export type InboundDeliver = (nodeId: string, topic: string, payload: Uint8Array) => void;

/** One Figma plugin-handshake publish (the core `FigmaPublish` serde shape). */
export type FigmaPublish = { brokerId: string; topic: string; payload: string; retain: boolean };
/** Compute the Figma connect/disconnect publishes for a uid-set change
 *  (`prev`/`next` are `uid -> brokerId`): `disconnected` on the broker a uid
 *  left, `connected` and a variables request on the broker a uid arrived on,
 *  both for a uid whose broker changed. The handshake *protocol* lives in core
 *  ([`figma_announce_actions`]); injected as the wasm binding so the performer
 *  stays host-free / unit-testable — the desktop host calls the same core fn. */
export type FigmaAnnounce = (
  prev: Record<string, string>,
  next: Record<string, string>,
) => FigmaPublish[];

/** A subscription a broker holds, and the link it is held on
 *  (`BrokerConnections.link`). */
type Held = ActiveSub & { link: number };

/** Where a Bridge ID is announced: the broker, and the link its announcement
 *  went out on, or goes out on when that link is up. */
type Said = { brokerId: string; link: number };

/**
 * Performs the cloud half of a flow host (ADR-0009): the LLM/MQTT network I/O a
 * turn's `Effects` record, plus the subscription reconcile (incl. Figma
 * handshake). The browser twin of the desktop `CloudPerformer` in
 * `src-tauri/src/runtime/cloud_performer.rs` — and like it, host-free: it owns the
 * {@link BrokerConnections}, the shared {@link LlmPerformer}, and the injected
 * {@link CloudDeps} resolvers, but reaches the runtime only through the two
 * injected callbacks ({@link ResultInjector} / {@link InboundDeliver}). No wasm
 * runtime, no board connection, no store — so it unit-tests directly.
 */
export class CloudPerformer {
  /** Per-broker MQTT-over-WSS connections. */
  private readonly brokers: BrokerConnections;
  /** The `llmGenerate` half — the same performer the desktop host holds
   *  (ADR-0021); only the result re-entry differs. */
  private readonly llm: LlmPerformer;
  /** What the flow wants subscribed: the last reconciled set. */
  private wanted = new Map<string, ActiveSub>();
  /** What the brokers hold for the flow, each on the link it is held on.
   *  Always a part of `wanted`. */
  private readonly live = new Map<string, Held>();
  /** The Bridge IDs the plugins were told Studio is connected for, by uid:
   *  the broker each was told on, and the link. */
  private announced = new Map<string, Said>();
  /** Per broker, what the policy gives for the Bridge IDs announced there
   *  vanishing: what {@link sayGoodbye} publishes there, and the first of it
   *  the will of the broker's links. Asked for each time the announce changes
   *  something, while the policy can still be asked. */
  private readonly farewells = new Map<string, FigmaPublish[]>();
  /** A change to `live` is being made; the announce waits for its end. */
  private settling = false;
  /** What is waiting for a broker and was said so already, so that a flow
   *  which stays unconnected is not reported at every reconcile and publish. */
  private readonly waiting = new Set<string>();
  /** The brokers something was published on, or is stored for, less than
   *  {@link BROKER_IDLE_MS} ago, each with the timer that ends that time. One
   *  of them keeps its connection without a topic wanted on it. */
  private readonly recent = new Map<string, unknown>();
  private readonly timers: Timers;
  /** Ends the watch on the broker settings. */
  private readonly unwatchBrokers: () => void;
  private disposed = false;

  constructor(
    private readonly cloud: CloudDeps | null,
    /** Re-enter an LLM result on the issuing node's handle (`injectEvent`). The
     *  reactor supplies the runtime + clock; mirrors `ActorMsg::Inject`. */
    private readonly resultInjector: ResultInjector,
    /** Route an inbound broker message to its subscribe node (`deliverMessage`);
     *  mirrors `ActorMsg::Deliver`. */
    private readonly deliverInbound: InboundDeliver,
    /** The Figma handshake policy — core's `figma_announce_actions`, supplied as
     *  the wasm binding so the performer never imports the runtime (a TS stub in
     *  tests). The desktop host calls the same core fn directly. */
    private readonly figmaAnnounce: FigmaAnnounce,
    /** Stubbed in tests; defaults to the real `mqtt.connect` wrapper. */
    factory: MqttClientFactory = defaultMqttClientFactory,
  ) {
    this.timers = this.cloud?.timers ?? realTimers;
    this.brokers = new BrokerConnections(
      factory,
      (brokerId) => this.sayGoodbye(brokerId),
      this.timers,
    );
    this.llm = new LlmPerformer(
      (providerId) => this.cloud?.resolveLlmProvider(providerId),
      (source, handle, value) => this.resultInjector(source, handle, value),
    );
    this.unwatchBrokers =
      this.cloud?.watchBrokers?.((brokerIds) => this.brokerSettingsChanged(brokerIds)) ??
      (() => {});
  }

  /** Perform one recorded cloud request. The `llmGenerate` → `LlmPerformer`,
   *  `mqttPublish` → `publishMqtt` switch; `mqttPublish` covers both the Mqtt
   *  publish node and Figma set-value. Nothing is performed after
   *  {@link dispose}, and nothing reconciled: a late request opens no
   *  connection that nobody would close. */
  perform(request: CloudRequest): void {
    if (this.disposed) return;
    if (request.kind === "llmGenerate") {
      void this.llm.perform(request);
      return;
    }
    // Intercepted by the reactor's Midi/Audio performers before delegation
    // (host peripherals, not network calls) — mirrors the desktop actor.
    if (request.kind !== "mqttPublish") {
      console.warn(
        `[cloud-performer] ${request.kind} reached the CloudPerformer — handled by the reactor`,
      );
      return;
    }
    this.publishMqtt(request.brokerId, request.topic, request.payload, request.retain);
  }

  /** Reconcile an already-reconciled desired subscription set (the wasm binding
   *  returns one per topic) into WSS subscriptions: let go of topics the flow no
   *  longer wants, ask the brokers for every wanted topic they do not hold,
   *  run the Figma uid connect/disconnect lifecycle on what they do hold, and
   *  close the connection of a broker the flow has no use for any more. Called
   *  by the reactor after every `applyFlow`; an unchanged set whose topics are
   *  all live touches no broker. */
  reconcile(reconciled: ActiveSub[]): void {
    if (this.disposed) return;
    const desired = new Map<string, ActiveSub>(
      reconciled.map((sub) => [subKey(sub.brokerId, sub.topic), sub] as const),
    );
    /** The brokers the flow wanted a topic on until now, and wants none on. */
    const left = new Set<string>();
    this.settle(() => {
      const letGo = diffSubscriptions(desired, this.wanted).unsubscribe;
      for (const sub of letGo) {
        const key = subKey(sub.brokerId, sub.topic);
        this.brokers.unsubscribe(sub.brokerId, sub.topic);
        this.live.delete(key);
        this.waiting.delete(`subscribe ${key}`);
      }
      this.wanted = desired;

      // Every broker the flow wants a topic on, so a changed config is picked
      // up even when all of its topics are live.
      const reachable = new Map<string, boolean>();
      for (const { brokerId } of desired.values()) {
        if (!reachable.has(brokerId)) reachable.set(brokerId, this.reach(brokerId));
      }
      for (const { brokerId } of letGo) {
        if (!reachable.has(brokerId)) left.add(brokerId);
      }
      for (const sub of diffSubscriptions(desired, this.live).subscribe) {
        if (reachable.get(sub.brokerId) === true) this.hold(sub);
        else this.warnUnconnected(sub);
      }
    });
    // The connections the flow stopped subscribing on just now, after the
    // announce above said `disconnected` on them for the Bridge IDs that left.
    // One the flow has no other use for closes here; so does one whose broker
    // was removed with the node.
    if (left.size > 0) {
      this.settle(() => {
        for (const brokerId of left) this.reach(brokerId);
      });
    }
  }

  /**
   * The page is going away (`pagehide`: closed, reloaded, navigated from, or
   * put in the back/forward cache): tell the plugins Studio left, on every
   * broker a Bridge ID is announced on, before the connections close without
   * a word. The connections stay as they are. A page that comes back from the
   * back/forward cache calls {@link rejoin}.
   */
  leave(): void {
    if (this.disposed) return;
    for (const brokerId of [...this.farewells.keys()]) this.sayGoodbye(brokerId);
  }

  /** The page came back from the back/forward cache (`pageshow`): announce
   *  again the Bridge IDs whose subscriptions the brokers hold. */
  rejoin(): void {
    if (this.disposed) return;
    this.settle(() => {});
  }

  /** Tear down: abort in-flight LLM calls, end every broker connection, and drop
   *  the subscription sets. Every step runs, whatever the ones before it threw:
   *  an error on the way never leaves a connection open. */
  dispose(): void {
    this.disposed = true;
    try {
      this.unwatchBrokers();
    } finally {
      for (const timer of this.recent.values()) this.timers.clear(timer);
      this.recent.clear();
      try {
        this.llm.dispose();
      } finally {
        // Each connection that is up first tells the plugins Studio is gone
        // (`sayGoodbye`), if they can be told.
        this.brokers.disposeAll();
        this.wanted = new Map();
        this.live.clear();
        this.announced.clear();
        this.farewells.clear();
      }
    }
  }

  // --- Cloud: MQTT + Figma over WSS (ADR-0009 Phase 3) ------------------------

  /**
   * Make `brokerId`'s connection follow its config and the use the flow has
   * for it, and say whether there is one to use. A broker that is not
   * configured, or whose URL no connection can be opened to from a browser,
   * has none; neither has one the flow does not use ({@link inUse}; a publish
   * that is about to be made passes `used`). Never throws.
   *
   * When that replaced or closed a connection, the subscriptions it held are
   * gone with it and leave the live set; the plugins on it were told Studio
   * left if its link was up (`sayGoodbye`). A connection that was just opened
   * is asked for everything the flow wants on that broker.
   */
  private reach(brokerId: string, used: boolean = this.inUse(brokerId)): boolean {
    const configured = used ? this.cloud?.resolveBroker(brokerId) : undefined;
    const conn =
      configured !== undefined && isBrowserReachableBroker(configured.url) ? configured : undefined;
    const { open, changed } = this.brokers.configure(brokerId, conn);
    // Without a connection there is nothing a past publish could keep.
    if (!open) this.forget(brokerId);
    if (changed) {
      for (const [key, sub] of this.live) {
        if (sub.brokerId === brokerId) this.live.delete(key);
      }
      // Whether or not its link was up to be told.
      for (const [uid, said] of this.announced) {
        if (said.brokerId === brokerId) this.announced.delete(uid);
      }
      this.farewells.delete(brokerId);
      if (open) {
        for (const sub of this.wanted.values()) {
          if (sub.brokerId === brokerId) this.hold(sub);
        }
      }
    }
    return open;
  }

  /**
   * The settled connection settings of `brokerIds` changed
   * ({@link CloudDeps.watchBrokers}): make the connection of each follow them,
   * with the flow as it is. The browser's counterpart of the desktop performer
   * reconciling its kept wirings when the broker pool changed, for the brokers
   * that changed; no other broker is touched.
   *
   * The connection of a broker in use ({@link inUse}) is opened, replaced or
   * closed as the settings say, and a new one is asked for everything the flow
   * wants there. A broker that is not in use has no connection and gets none:
   * the next publish to it reads its settings.
   */
  private brokerSettingsChanged(brokerIds: readonly string[]): void {
    if (this.disposed) return;
    for (const brokerId of brokerIds) {
      this.settle(() => {
        if (this.reach(brokerId)) return;
        for (const sub of this.wanted.values()) {
          if (sub.brokerId === brokerId) this.warnUnconnected(sub);
        }
      });
    }
  }

  /**
   * Whether the flow uses `brokerId`: it wants a topic on it, or something was
   * published on it, or is stored for it, less than {@link BROKER_IDLE_MS} ago.
   * Only a broker in use has a connection.
   *
   * Which brokers a flow's publishing nodes refer to is not known here
   * (`reconcile` is given the subscriptions), so a broker that is only
   * published to is in use for as long as publishes keep coming. One that goes
   * quiet for longer loses its connection, and the next publish opens it again
   * and is sent on it (`OPENING_PUBLISH_MS`).
   */
  private inUse(brokerId: string): boolean {
    if (this.recent.has(brokerId)) return true;
    for (const sub of this.wanted.values()) {
      if (sub.brokerId === brokerId) return true;
    }
    return false;
  }

  /** Something was published on `brokerId`'s connection, or is stored for it:
   *  the broker is in use for {@link BROKER_IDLE_MS} from now. */
  private used(brokerId: string): void {
    this.forget(brokerId);
    this.recent.set(
      brokerId,
      this.timers.set(() => {
        this.recent.delete(brokerId);
        // Still wanted: nothing changes for its connection.
        if (!this.inUse(brokerId)) this.settle(() => this.reach(brokerId));
      }, BROKER_IDLE_MS),
    );
  }

  /** `brokerId` is not kept by a past publish any longer. */
  private forget(brokerId: string): void {
    if (!this.recent.has(brokerId)) return;
    this.timers.clear(this.recent.get(brokerId));
    this.recent.delete(brokerId);
  }

  /**
   * `brokerId`'s connection is about to be replaced or closed while its link is
   * up: tell the plugins Studio is gone, for every Bridge ID announced on it,
   * with the publishes core's policy gave for those Bridge IDs vanishing when
   * they were announced ({@link farewells}). Otherwise that broker would keep a
   * retained `connected` for a Studio that is no longer there. The policy is
   * not asked now: its module may have trapped, which is when the flow host
   * tears everything down.
   *
   * Should a publish throw, the error goes to the caller (the connection closes
   * all the same, see {@link BrokerConnections}), and the Bridge IDs are
   * announced nowhere.
   *
   * The links keep their will: what it says is true from here on, and a
   * connection that closes drops it with its DISCONNECT.
   */
  private sayGoodbye(brokerId: string): void {
    const farewell = this.farewells.get(brokerId) ?? [];
    this.farewells.delete(brokerId);
    try {
      for (const a of farewell) this.publishStatus(a);
    } finally {
      for (const [uid, said] of this.announced) {
        if (said.brokerId === brokerId) this.announced.delete(uid);
      }
    }
  }

  /** Log that something waits for a broker, once until it stops waiting. */
  private warnWaiting(what: string, message: string): void {
    if (this.waiting.has(what)) return;
    this.waiting.add(what);
    console.warn(message);
  }

  /** `sub` is wanted and its broker has no connection to ask it of: the broker
   *  is not configured, or its URL cannot be opened. */
  private warnUnconnected(sub: ActiveSub): void {
    this.warnWaiting(
      `subscribe ${subKey(sub.brokerId, sub.topic)}`,
      `[cloud-performer] no connection to broker '${sub.brokerId}' to subscribe ${sub.topic} on, will retry`,
    );
  }

  /** Ask `sub`'s broker to hold it; `live` follows the broker's answer, and
   *  records the link that gave it. */
  private hold(sub: ActiveSub): void {
    const key = subKey(sub.brokerId, sub.topic);
    this.waiting.delete(`subscribe ${key}`);
    this.brokers.subscribe(
      sub.brokerId,
      sub.topic,
      (topic, payload) => this.onInbound(sub, topic, payload),
      (held) =>
        this.settle(() => {
          if (held) this.live.set(key, { ...sub, link: this.brokers.link(sub.brokerId) });
          else this.live.delete(key);
        }),
    );
  }

  /** Change the live set, then announce what the change did to the Bridge IDs.
   *  Changes made inside another one share its announce. */
  private settle(change: () => void): void {
    if (this.settling) {
      change();
      return;
    }
    this.settling = true;
    try {
      change();
    } finally {
      this.settling = false;
    }
    this.announce();
  }

  /** Inbound broker message: routing kinds drive the flow via {@link InboundDeliver}
   *  (the runtime's `deliverMessage`); every message is also offered to the
   *  optional UI feed (the desktop emits the same "mqtt-message" for both — the
   *  Figma store filters by topic). */
  private onInbound(sub: ActiveSub, topic: string, payload: Uint8Array): void {
    if (this.disposed) return;
    if (sub.kind === "plain" || sub.kind === "topicAware") {
      this.deliverInbound(sub.nodeId, topic, payload);
      this.cloud?.onMqttMessage?.(topic, payload, sub.nodeId);
    } else {
      this.cloud?.onMqttMessage?.(topic, payload);
    }
  }

  /** Figma plugin handshake over MQTT, driven by the live-uid delta. The protocol
   *  — a uid that left its broker → `disconnected` there; a uid that arrived on
   *  its broker → `connected` (retained) + a variables request there — lives in
   *  core (via the injected {@link FigmaAnnounce}, core's
   *  `figma_announce_actions`); here we only perform the returned publishes, in
   *  the order core gives them. The desktop host calls the same core policy on
   *  its own live set, so both hosts announce identically. */
  private announce(): void {
    const was = new Map([...this.announced].map(([uid, said]) => [uid, said.brokerId] as const));
    // A Bridge ID stays on the broker it was announced on while that broker
    // holds one of its topics, so `connected` and `disconnected` reach the same
    // broker. Once that broker holds none, the Bridge ID leaves it and arrives
    // on another broker that holds it, if there is one.
    const next = uidBrokers(this.live.values(), was);
    // No Bridge ID before or after: nobody to tell anything.
    if (was.size === 0 && next.size === 0) return;
    const actions = this.figmaAnnounce(Object.fromEntries(was), Object.fromEntries(next));
    // The Bridge IDs that stay where they are, announced on an earlier link
    // of their broker than the one up now, which holds one of their topics:
    // told again, as they arrived (see the rule at the top).
    const onLinkUp = uidBrokers(
      [...this.live.values()].filter((held) => held.link === this.brokers.link(held.brokerId)),
      next,
    );
    const again = [...next]
      .filter(([uid, brokerId]) => {
        const said = this.announced.get(uid);
        return (
          said?.brokerId === brokerId &&
          said.link < this.brokers.link(brokerId) &&
          onLinkUp.get(uid) === brokerId
        );
      })
      .map(([uid]) => uid)
      .sort();
    const hellos = again.flatMap((uid) => this.figmaAnnounce({}, { [uid]: next.get(uid)! }));
    // On the connections as they are. A Bridge ID that leaves a broker is
    // announced on the connection that broker has, and one that arrives is live
    // on the connection it is announced on. Making a connection follow its
    // config here could close the very one a `disconnected` is for; that is
    // `reach`'s to do, which says goodbye from what `announced` still holds.
    for (const a of [...actions, ...hellos]) {
      // Stored for a link that is down: the connection is kept for it to come
      // back, also when the flow wants nothing more on that broker.
      if (this.publishStatus(a) === "kept") this.used(a.brokerId);
    }
    // Only now, with every publish handed to its connection: on the link
    // that is up, or the next one.
    const announced = new Map<string, Said>();
    for (const [uid, brokerId] of next) {
      const said = this.announced.get(uid);
      const kept = said?.brokerId === brokerId && !again.includes(uid);
      announced.set(uid, kept ? said : { brokerId, link: this.brokers.link(brokerId) });
    }
    this.announced = announced;
    // What to say when the connections close, asked while the policy answers.
    // Nothing changed, nothing to ask: and a policy that answers nothing (its
    // module trapped) leaves the goodbyes of what was announced before.
    if (actions.length === 0) return;
    const before = [...this.farewells.keys()];
    this.farewells.clear();
    if (next.size > 0) {
      for (const a of this.figmaAnnounce(Object.fromEntries(next), {})) {
        this.farewells.set(a.brokerId, [...(this.farewells.get(a.brokerId) ?? []), a]);
      }
    }
    // The first goodbye of each broker is its links' will.
    for (const brokerId of new Set([...before, ...this.farewells.keys()])) {
      const first = this.farewells.get(brokerId)?.[0];
      const will: Will | undefined = first && {
        topic: first.topic,
        payload: first.payload,
        retain: first.retain,
      };
      this.brokers.setWill(brokerId, will);
    }
  }

  /** Hand one publish of the design-tool handshake to its broker's connection.
   *  It waits there for a link that is down (see the rule at the top). */
  private publishStatus(a: FigmaPublish): Published {
    return this.brokers.publish(a.brokerId, a.topic, new TextEncoder().encode(a.payload), {
      retain: a.retain,
      whenDown: "keep",
    });
  }

  /** Perform a flow's publish. It is sent now or not at all (see the rule at
   *  the top); what is dropped is said once per broker, until one is sent. A
   *  topic no message can be published on (a wildcard, an empty one) is said
   *  once and goes nowhere: a broker would close the connection over it. */
  private publishMqtt(brokerId: string, topic: string, payload: number[], retain: boolean): void {
    if (!isTopicName(topic)) {
      this.warnWaiting(
        `topic ${topic}`,
        `[cloud-performer] '${topic}' is not a topic a message can be published on (it holds a wildcard or is empty); publishes to it are dropped`,
      );
      return;
    }
    // As a change to the live set, like every `reach`: a connection this
    // closes may have been the one a Bridge ID was announced on, and what is
    // left of that Bridge ID on another broker is announced now.
    let open = false;
    this.settle(() => {
      open = this.reach(brokerId, true);
    });
    if (!open) {
      this.warnWaiting(
        `publish ${brokerId}`,
        `[cloud-performer] no connection to broker '${brokerId}' to publish to ${topic} on; publishes to it are dropped`,
      );
      return;
    }
    this.used(brokerId);
    this.waiting.delete(`publish ${brokerId}`);
    const published = this.brokers.publish(brokerId, topic, Uint8Array.from(payload), {
      retain,
      whenDown: "drop",
    });
    if (published === "dropped") {
      this.warnWaiting(
        `link ${brokerId}`,
        `[cloud-performer] the link to broker '${brokerId}' is down; publishes to it are dropped until it is back`,
      );
    } else {
      this.waiting.delete(`link ${brokerId}`);
    }
  }
}
