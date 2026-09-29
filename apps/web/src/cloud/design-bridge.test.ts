import { beforeEach, describe, expect, test } from "bun:test";
import { bridgeIdOf, useDesignBridgeStore } from "./design-bridge";

const store = () => useDesignBridgeStore.getState();

describe("bridgeIdOf", () => {
  const base = { customBridgeId: null, deviceBridgeId: "calm_lynx_4821", accountName: null };

  test("prefers the user's own Bridge ID", () => {
    expect(bridgeIdOf({ ...base, customBridgeId: "swift_fox", accountName: "xiduzo" })).toBe(
      "swift_fox",
    );
  });

  test("derives one from the account name", () => {
    expect(bridgeIdOf({ ...base, accountName: "Sander Boer" })).toBe("Sander_Boer");
  });

  test("falls back to the device ID when the name is unusable", () => {
    expect(bridgeIdOf({ ...base, accountName: "Al" })).toBe("calm_lynx_4821");
    expect(bridgeIdOf(base)).toBe("calm_lynx_4821");
  });
});

describe("design-bridge store", () => {
  beforeEach(() => {
    useDesignBridgeStore.setState({
      customBridgeId: "swift_fox",
      variables: { figma: {}, penpot: {} },
      connected: { figma: false, penpot: false },
    });
  });

  test("keeps each tool's variable list and status apart", () => {
    const figma = { "VariableID:1:2": { id: "VariableID:1:2", name: "led", resolvedType: "BOOLEAN" } };
    const penpot = { "3f9a": { id: "3f9a", name: "size", resolvedType: "FLOAT" } };
    store().ingestMqttMessage("microflow/swift_fox/figma/variables", JSON.stringify(figma));
    store().ingestMqttMessage("microflow/swift_fox/penpot/variables", JSON.stringify(penpot));
    store().ingestMqttMessage("microflow/swift_fox/penpot/status", "connected");

    expect(store().variables).toEqual({ figma, penpot } as never);
    expect(store().connected).toEqual({ figma: false, penpot: true });
  });

  test("ignores other Bridge IDs, Studio's own topics and legacy responses", () => {
    store().ingestMqttMessage("microflow/other_id/figma/status", "connected");
    store().ingestMqttMessage("microflow/swift_fox/app/status", "connected");
    store().ingestMqttMessage("microflow/swift_fox/app/variables/response", "{}");
    expect(store().connected).toEqual({ figma: false, penpot: false });
  });

  test("rejects an invalid custom Bridge ID and resets tool state on change", () => {
    store().ingestMqttMessage("microflow/swift_fox/figma/status", "connected");
    store().setCustomBridgeId("no spaces allowed");
    expect(store().customBridgeId).toBe("swift_fox");
    store().setCustomBridgeId("bold_owl");
    expect(store().customBridgeId).toBe("bold_owl");
    expect(store().connected.figma).toBe(false);
  });
});
