// The broker settings as the two hosts' capability sync and a flow update get
// them: settled, once per change, however they were typed.
//
// The desktop host's sync is driven with its IPC call replaced (it needs the
// desktop app behind it): what is recorded is the broker list each
// `mqtt_sync_brokers` would carry.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FlowDocument } from "@microflow/collab";

import { FlowUpdateDispatcher, ManualDispatchScheduler } from "@/runtime/flow-update-dispatcher";
import type { FlowSession } from "@/session";

import type { BrokerStatuses } from "@/lib/bindings/BrokerStatuses";
import {
  CLOUD_CAPABILITIES,
  desktopBrokerCapability,
  type DesktopBrokerIpc,
  hostSnapshotForFlowUpdate,
  probeBrokerStatuses,
  probeLlmStatuses,
  readHostSnapshot,
} from "./cloud-capabilities";
import { settleLlmProviders, useLlmProviderStore, type LlmProviderConfig } from "@/ai/llm-provider";
import type { BrokerProbe, LlmProbeOutcome } from "./browser-cloud-probe";
import { startCloudCapabilitySync } from "./cloud-capability-sync";
import {
  resolveStoredBroker,
  settleBrokerSettings,
  useMqttBrokerStore,
  type ConnectionStatus,
  type MqttBrokerConfig,
} from "./mqtt-broker";
import { MQTT5_REQUIRED } from "./mqtt-refusal";

const LAB: MqttBrokerConfig = { id: "lab", name: "Lab", url: "mqtt://lab.example:1883", isDefault: true };
const HOME: MqttBrokerConfig = { id: "home", name: "Home", url: "mqtt://home.example:1883", isDefault: false };

const store = () => useMqttBrokerStore.getState();

const cleanups: Array<() => void> = [];

beforeEach(() => {
  useMqttBrokerStore.setState({ brokers: [{ ...LAB }, { ...HOME }], unsettled: {}, statuses: {}, problems: {} });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  // Ends the settle waits of whatever a test left typed.
  settleBrokerSettings();
  useMqttBrokerStore.setState({ brokers: [], unsettled: {}, statuses: {} });
});

/** The desktop host's broker sync, started: the URL of broker `lab` in every
 *  list it sent, the list sent on start included. */
function desktopSync(): Array<string | undefined> {
  const mqtt = CLOUD_CAPABILITIES.find((capability) => capability.name === "mqtt");
  if (!mqtt?.sync) throw new Error("the mqtt capability syncs");
  const { read, subscribe } = mqtt.sync;
  const sent: Array<string | undefined> = [];
  const push = () =>
    sent.push((read() as MqttBrokerConfig[]).find((broker) => broker.id === "lab")?.url);
  cleanups.push(
    startCloudCapabilitySync([{ ...mqtt, listen: undefined, sync: { read, subscribe, push } }]),
  );
  return sent;
}

/** Type `url` into the URL field of broker `lab`, a keystroke at a time. */
function typeUrl(url: string): void {
  for (let length = 1; length <= url.length; length++) {
    store().updateBroker("lab", { url: url.slice(0, length) });
  }
}

describe("the desktop host's broker sync", () => {
  test("sends the list once for a URL that is typed, when it has settled", () => {
    const sent = desktopSync();
    expect(sent).toEqual([LAB.url]);

    typeUrl("mqtts://lab.example:8883");
    expect(sent).toEqual([LAB.url]);

    settleBrokerSettings();
    expect(sent).toEqual([LAB.url, "mqtts://lab.example:8883"]);
  });

  test("sends the list at once for a broker added or removed, without what is still typed", () => {
    const sent = desktopSync();
    typeUrl("mqtts://lab.exam");

    const added = store().addBroker({ name: "Shed", url: "mqtt://shed.example", isDefault: false });
    store().deleteBroker(added);
    store().deleteBroker("home");

    expect(sent).toEqual([LAB.url, LAB.url, LAB.url, LAB.url]);
  });

  test("sends nothing for a status dot that changes", () => {
    const sent = desktopSync();

    store().setStatuses({ lab: "connected" });
    store().setStatus("home", "error");

    expect(sent).toEqual([LAB.url]);
  });
});

describe("a flow update", () => {
  test("carries the broker settings as they are typed: what has not settled is settled first", () => {
    const sent = desktopSync();
    typeUrl("mqtts://lab.example:8883");

    const snapshot = hostSnapshotForFlowUpdate();

    expect(snapshot.brokers.find((broker) => broker.id === "lab")?.url).toBe("mqtts://lab.example:8883");
    // The host has the settings before it gets the flow that uses them.
    expect(sent).toEqual([LAB.url, "mqtts://lab.example:8883"]);
    expect(store().unsettled).toEqual({});
  });

  test("sent by the dispatcher right after a URL was typed reaches the runtime with that URL", async () => {
    // A flow with one node on broker `lab`, and the dispatcher the editor
    // mounts for it, on a scheduler and a sender the test holds.
    const doc = FlowDocument.createEmpty();
    doc.addNode({ id: "mqtt-1", type: "Mqtt", position: { x: 0, y: 0 }, data: { instance: "Mqtt", brokerId: "lab" } });
    const session: FlowSession = {
      flowId: "test",
      mode: "local",
      readOnly: false,
      doc,
      sync: { kind: "local", destroy: () => {} },
      destroy: () => {},
    };
    const flows: Array<{ brokers: Array<{ id: string; url: string }> }> = [];
    const scheduler = new ManualDispatchScheduler();
    const dispatcher = new FlowUpdateDispatcher(
      session,
      hostSnapshotForFlowUpdate,
      {
        send: async (update) => {
          flows.push(update);
          return { ok: true };
        },
      },
      scheduler,
      { Mqtt: { adapter: { brokerIds: () => ["lab"] } } },
    );
    cleanups.push(() => dispatcher.destroy());

    typeUrl("mqtts://lab.example:8883");
    scheduler.flush();
    await Promise.resolve();

    expect(flows.map((flow) => flow.brokers)).toEqual([
      [{ id: "lab", name: "Lab", url: "mqtts://lab.example:8883", username: undefined, password: undefined }],
    ]);
    // And the browser CloudPerformer, which reads the store, finds the same.
    expect(resolveStoredBroker("lab")?.url).toBe("mqtts://lab.example:8883");
  });

  test("leaves settled settings as they are", () => {
    const sent = desktopSync();
    const before = store().brokers;

    expect(hostSnapshotForFlowUpdate().brokers).toBe(before);
    expect(sent).toEqual([LAB.url]);
  });

  test("is the only reader that settles: reading the snapshot for anything else changes nothing", () => {
    const sent = desktopSync();
    typeUrl("mqtts://lab.example:8883");

    expect(readHostSnapshot().brokers.find((broker) => broker.id === "lab")?.url).toBe(LAB.url);
    expect(sent).toEqual([LAB.url]);
  });
});

describe("the browser's broker status probe", () => {
  /** A probe whose answers a test gives by hand, in any order. */
  function heldProbe() {
    const asked: Array<{
      url: string;
      answer: (status: ConnectionStatus, problem?: string) => Promise<void>;
    }> = [];
    const probe = (broker: MqttBrokerConfig) =>
      new Promise<BrokerProbe>((resolve) => {
        asked.push({
          url: broker.url,
          answer: async (status, problem) => {
            resolve(problem === undefined ? { status } : { status, problem });
            await Promise.resolve();
          },
        });
      });
    return { asked, probe };
  }

  const dot = (id: string) => store().statuses[id];

  test("shows each broker as connecting, then as the probe answered", async () => {
    const { asked, probe } = heldProbe();

    probeBrokerStatuses(probe);
    expect([dot("lab"), dot("home")]).toEqual(["connecting", "connecting"]);

    await asked[0]?.answer("connected");
    await asked[1]?.answer("error");
    expect([dot("lab"), dot("home")]).toEqual(["connected", "error"]);
  });

  test("shows why a broker is in error when the probe says", async () => {
    const { asked, probe } = heldProbe();

    probeBrokerStatuses(probe);
    await asked[0]?.answer("error", MQTT5_REQUIRED);
    expect([dot("lab"), store().problems.lab]).toEqual(["error", MQTT5_REQUIRED]);

    probeBrokerStatuses(probe);
    expect(store().problems.lab).toBeUndefined();
  });

  test("drops an answer that arrives after the broker's settings changed again", async () => {
    const { asked, probe } = heldProbe();
    useMqttBrokerStore.setState({ brokers: [{ ...LAB }] });
    probeBrokerStatuses(probe);

    // The URL is corrected while the first probe is still waiting for a
    // broker that is not there.
    store().updateBroker("lab", { url: "wss://lab.example/mqtt" });
    settleBrokerSettings();
    probeBrokerStatuses(probe);
    expect(asked.map((probed) => probed.url)).toEqual([LAB.url, "wss://lab.example/mqtt"]);

    await asked[1]?.answer("connected");
    await asked[0]?.answer("error");

    expect(dot("lab")).toBe("connected");
  });

  test("does not bring back the status of a broker that was removed meanwhile", async () => {
    const { asked, probe } = heldProbe();
    probeBrokerStatuses(probe);

    store().deleteBroker("home");
    for (const probed of asked) await probed.answer("connected");

    expect(store().statuses).toEqual({ lab: "connected" });
  });
});

describe("the LLM provider status probe", () => {
  const OPENAI: LlmProviderConfig = {
    id: "openai",
    name: "OpenAI",
    kind: "http",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-1",
    model: "gpt-4o-mini",
    isDefault: true,
  };
  const llmStore = () => useLlmProviderStore.getState();

  beforeEach(() => {
    const providers = [{ ...OPENAI }];
    useLlmProviderStore.setState({ providers, settled: providers, statuses: {} });
  });

  afterEach(() => {
    settleLlmProviders();
    useLlmProviderStore.setState({ providers: [], settled: [], statuses: {} });
  });

  /** A probe whose answers a test gives by hand, in any order. */
  function heldProbe() {
    const asked: Array<{ apiKey: string; answer: (outcome: LlmProbeOutcome) => Promise<void> }> = [];
    const probe = (provider: LlmProviderConfig) =>
      new Promise<LlmProbeOutcome>((resolve) => {
        asked.push({
          apiKey: provider.apiKey,
          answer: async (outcome) => {
            resolve(outcome);
            await Promise.resolve();
          },
        });
      });
    return { asked, probe };
  }

  test("is not sent a key that is being typed, only the key it settles to", () => {
    const llm = CLOUD_CAPABILITIES.find((capability) => capability.name === "llm");
    if (!llm?.sync) throw new Error("the llm capability syncs");
    const { read, subscribe } = llm.sync;
    const probed: string[] = [];
    const push = () => {
      for (const provider of read() as LlmProviderConfig[]) probed.push(provider.apiKey);
    };
    cleanups.push(startCloudCapabilitySync([{ ...llm, sync: { read, subscribe, push } }]));

    for (const key of ["s", "sk", "sk-", "sk-n", "sk-ne", "sk-new"]) {
      llmStore().updateProvider("openai", { apiKey: key });
    }
    expect(probed).toEqual(["sk-1"]);

    settleLlmProviders();
    expect(probed).toEqual(["sk-1", "sk-new"]);
  });

  test("drops an answer that arrives after the provider's key settled to another", async () => {
    const { asked, probe } = heldProbe();
    probeLlmStatuses(probe);
    expect(llmStore().statuses.openai).toBe("testing");

    llmStore().updateProvider("openai", { apiKey: "sk-2" });
    settleLlmProviders();
    probeLlmStatuses(probe);
    expect(asked.map((probed) => probed.apiKey)).toEqual(["sk-1", "sk-2"]);

    await asked[1]?.answer({ kind: "ok" });
    await asked[0]?.answer({ kind: "httpError", status: 401 });

    expect(llmStore().statuses.openai).toBe("ok");
  });

  test("does not bring back the status of a provider that was removed meanwhile", async () => {
    const { asked, probe } = heldProbe();
    probeLlmStatuses(probe);

    llmStore().deleteProvider("openai");
    await asked[0]?.answer({ kind: "ok" });

    expect(llmStore().statuses).toEqual({});
  });
});

// The desktop host reports every broker's status two ways — the answer to the
// sync and the status event — and they arrive in either order: a broker on
// localhost is connected before the answer saying it is connecting is back.
describe("the desktop's broker status dots", () => {
  /** A desktop host whose answers and events the test hands over. */
  function fakeHost() {
    let onSnapshot: (snapshot: BrokerStatuses) => void = () => {};
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const answers: Array<(snapshot: BrokerStatuses) => void> = [];
    const ipc: DesktopBrokerIpc = {
      listen: async (handler) => {
        await opened;
        onSnapshot = handler;
        return () => {
          onSnapshot = () => {};
        };
      },
      sync: () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    };
    return {
      ipc,
      open,
      event: (snapshot: BrokerStatuses) => onSnapshot(snapshot),
      answer: (snapshot: BrokerStatuses) => answers.shift()?.(snapshot),
      syncs: () => answers.length,
    };
  }

  const lab = (seq: number, status: ConnectionStatus, problem: string | null = null): BrokerStatuses => ({
    seq,
    brokers: [{ id: "lab", status, problem }],
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function started() {
    const host = fakeHost();
    cleanups.push(startCloudCapabilitySync([desktopBrokerCapability(host.ipc)]));
    host.open();
    await settle();
    return host;
  }

  test("the status event is listened to before the broker list is sent", async () => {
    const host = fakeHost();
    cleanups.push(startCloudCapabilitySync([desktopBrokerCapability(host.ipc)]));
    await settle();
    expect(host.syncs()).toBe(0);

    host.open();
    await settle();
    expect(host.syncs()).toBe(1);
  });

  test("an answer that arrives after a newer event leaves the dot as the event set it", async () => {
    const host = await started();

    host.event(lab(2, "connected"));
    host.answer(lab(1, "connecting"));
    await settle();

    expect(store().statuses.lab).toBe("connected");
  });

  test("an event that arrives after the answer moves the dot on", async () => {
    const host = await started();

    host.answer(lab(1, "connecting"));
    await settle();
    expect(store().statuses.lab).toBe("connecting");
    host.event(lab(2, "connected"));

    expect(store().statuses.lab).toBe("connected");
  });

  test("a snapshot under the number already shown shows the same, and is taken", async () => {
    const host = await started();

    host.event(lab(3, "connected"));
    host.answer(lab(3, "connected"));
    await settle();

    expect(store().statuses.lab).toBe("connected");
  });

  test("a broker the host says why it is in error for shows why, until a snapshot without it", async () => {
    const host = await started();

    host.event(lab(2, "error", MQTT5_REQUIRED));
    expect([store().statuses.lab, store().problems.lab]).toEqual(["error", MQTT5_REQUIRED]);

    host.event(lab(3, "connecting"));
    expect([store().statuses.lab, store().problems.lab]).toEqual(["connecting", undefined]);
  });
});
