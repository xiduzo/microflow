import { describe, expect, test } from "bun:test";
import {
  assembleHostSnapshot,
  startCloudCapabilitySync,
  type CloudCapability,
} from "../cloud-capability-sync";
import type { HostSnapshot } from "../flow-update-dispatcher";

/** Minimal zustand-like store: a slice reference plus change notifications. */
function makeFakeStore<T>(initial: T) {
  let slice = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => slice,
    subscribe: (onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    /** Replace the slice (new reference) and notify, like a config edit. */
    setSlice: (next: T) => {
      slice = next;
      for (const l of listeners) l();
    },
    /** Notify without changing the slice reference, like a status update. */
    touch: () => {
      for (const l of listeners) l();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function makeCapability<T>(name: string, store: ReturnType<typeof makeFakeStore<T>>) {
  const pushes: T[] = [];
  const capability: CloudCapability = {
    name,
    sync: {
      read: store.read,
      subscribe: store.subscribe,
      push: () => pushes.push(store.read()),
    },
    snapshot: () => ({}),
  };
  return { capability, pushes };
}

describe("startCloudCapabilitySync", () => {
  test("pushes each capability once on start", () => {
    const brokers = makeFakeStore([{ id: "b1" }]);
    const providers = makeFakeStore([{ id: "p1" }]);
    const mqtt = makeCapability("mqtt", brokers);
    const llm = makeCapability("llm", providers);

    const stop = startCloudCapabilitySync([mqtt.capability, llm.capability]);

    expect(mqtt.pushes).toEqual([[{ id: "b1" }]]);
    expect(llm.pushes).toEqual([[{ id: "p1" }]]);
    stop();
  });

  test("re-pushes when the config slice reference changes", () => {
    const store = makeFakeStore([{ id: "b1" }]);
    const { capability, pushes } = makeCapability("mqtt", store);
    const stop = startCloudCapabilitySync([capability]);

    store.setSlice([{ id: "b1" }, { id: "b2" }]);

    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toEqual([{ id: "b1" }, { id: "b2" }]);
    stop();
  });

  test("ignores store churn that keeps the same slice reference (status updates)", () => {
    const store = makeFakeStore([{ id: "b1" }]);
    const { capability, pushes } = makeCapability("mqtt", store);
    const stop = startCloudCapabilitySync([capability]);

    store.touch();
    store.touch();

    expect(pushes).toHaveLength(1); // only the initial push
    stop();
  });

  test("cleanup unsubscribes; later changes no longer push", () => {
    const store = makeFakeStore([{ id: "b1" }]);
    const { capability, pushes } = makeCapability("mqtt", store);
    const stop = startCloudCapabilitySync([capability]);

    stop();
    store.setSlice([]);

    expect(pushes).toHaveLength(1);
    expect(store.listenerCount).toBe(0);
  });

  test("starts and cleans up listen channels; snapshot-only capabilities need no sync", () => {
    let listening = false;
    const withListen: CloudCapability = {
      name: "mqtt",
      listen: () => {
        listening = true;
        return () => {
          listening = false;
        };
      },
      snapshot: () => ({}),
    };
    const snapshotOnly: CloudCapability = {
      name: "figma",
      snapshot: () => ({ figma: { uniqueId: "u1" } }),
    };

    const stop = startCloudCapabilitySync([withListen, snapshotOnly]);
    expect(listening).toBe(true);
    stop();
    expect(listening).toBe(false);
  });
});

describe("assembleHostSnapshot", () => {
  test("merges each capability's contribution into one HostSnapshot", () => {
    const capabilities: CloudCapability[] = [
      { name: "mqtt", snapshot: () => ({ brokers: [] }) },
      {
        name: "llm",
        snapshot: () => ({
          providers: [
            { id: "p1", name: "openai", baseUrl: "https://x", apiKey: "k", isDefault: true },
          ],
        }),
      },
      { name: "figma", snapshot: () => ({ figma: { uniqueId: "sander" } }) },
    ];

    const snapshot: HostSnapshot = assembleHostSnapshot(capabilities);

    expect(snapshot).toEqual({
      brokers: [],
      providers: [{ id: "p1", name: "openai", baseUrl: "https://x", apiKey: "k", isDefault: true }],
      figma: { uniqueId: "sander" },
    });
  });
});
