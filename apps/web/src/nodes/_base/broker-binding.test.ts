// Runs as the browser host: `bun test` has no Tauri window, so a broker that
// is not a WebSocket is out of reach. On the desktop every broker is in reach
// (`browser-support.test.ts` covers that side of `hostLimitation`).

import { describe, expect, test } from "bun:test";
import type { FlowNode } from "@microflow/collab";
import { brokerBinding } from "./broker-binding";
import { brokerIds } from "./broker-binding.adapter";

const broker = (id: string, name: string, url = `wss://${id}.example`, isDefault = false) => ({
  id,
  name,
  url,
  isDefault,
});

const optionsOf = (...brokers: ReturnType<typeof broker>[]) => brokerBinding(brokers, "").control.options;

describe("the broker select", () => {
  test("without brokers offers only the unbound option", () => {
    expect(optionsOf()).toEqual({ "Select broker...": "" });
  });

  test("labels one broker by its name and stores its id", () => {
    expect(optionsOf(broker("id-home", "Home"))).toEqual({ "Select broker...": "", Home: "id-home" });
  });

  test("marks the default broker", () => {
    expect(optionsOf(broker("id-home", "Home", "wss://home.example", true))).toEqual({
      "Select broker...": "",
      "Home (default)": "id-home",
    });
  });

  test("tells two brokers with the same name apart by their address", () => {
    const options = optionsOf(
      broker("id-one", "Home", "wss://one.example"),
      broker("id-two", "Home", "mqtt://two.example:1883"),
    );
    expect(options).toEqual({
      "Select broker...": "",
      "Home · wss://one.example": "id-one",
      "Home · mqtt://two.example:1883": "id-two",
    });
  });

  test("does not show the credentials an address carries", () => {
    const options = optionsOf(
      broker("id-one", "Home", "wss://ada:secret@one.example"),
      broker("id-two", "Home", "wss://two.example"),
    );
    expect(Object.keys(options)).toEqual(["Select broker...", "Home · wss://one.example", "Home · wss://two.example"]);
  });

  test.each([
    "p@ss",
    "p/ss",
    "p@s/s",
    "s/e@c?r#t",
    "@",
    "/",
    "//x@y//",
  ])("shows no part of a password that holds %p", (password) => {
    const options = optionsOf(
      broker("id-one", "Home", `wss://ada:${password}@one.example:8884/mqtt`),
      broker("id-two", "Home", "wss://two.example"),
      broker("id-three", "Office", `ada:${password}@three.example`),
    );
    expect(Object.keys(options)).toEqual([
      "Select broker...",
      "Home · wss://one.example:8884/mqtt",
      "Home · wss://two.example",
      "Office",
    ]);
  });

  test("shows no part of a password in an address that has no scheme", () => {
    const options = optionsOf(
      broker("id-one", "Home", "ada:p@ss/word@one.example"),
      broker("id-two", "Home", "two.example"),
    );
    expect(Object.keys(options)).toEqual(["Select broker...", "Home · one.example", "Home · two.example"]);
  });

  test("tells two brokers with the same name and address apart by their id", () => {
    const options = optionsOf(
      broker("aaa-111111", "Home", "wss://same.example"),
      broker("bbb-222222", "Home", "wss://same.example"),
    );
    expect(options).toEqual({
      "Select broker...": "",
      "Home · 111111": "aaa-111111",
      "Home · 222222": "bbb-222222",
    });
  });

  test("stores every broker's id, however their labels collide", () => {
    const brokers = [
      broker("a-000001", "Home", "wss://same.example"),
      broker("b-000001", "Home", "wss://same.example"),
      broker("c-000001", "Home", ""),
      broker("d-000002", "Select broker..."),
      broker("e-000003", "Home · wss://other.example"),
      broker("f-000004", "Home", "wss://other.example"),
      broker("g-000005", "Studio", "wss://studio.example", true),
      broker("h-000006", "Studio", "wss://studio.example"),
    ];
    const options = optionsOf(...brokers);

    // One option per broker and the unbound one: no label replaced another.
    expect(Object.values(options)).toEqual(["", ...brokers.map(({ id }) => id)]);
    expect(options["Select broker..."]).toBe("");
  });

  test("selects the id the node holds", () => {
    const brokers = [broker("id-home", "Home")];
    expect(brokerBinding(brokers, "id-home").control).toMatchObject({ value: "id-home", label: "Broker" });
  });

  test("keeps its options for as long as the broker list is the same list", () => {
    const brokers = [broker("id-home", "Home"), broker("id-lab", "Lab")];
    expect(brokerBinding(brokers, "id-lab").control.options).toBe(brokerBinding(brokers, "id-home").control.options);
    expect(brokerBinding([...brokers], "id-home").control.options).not.toBe(
      brokerBinding(brokers, "id-home").control.options,
    );
  });
});

describe("why a node cannot reach a broker", () => {
  const home = broker("id-home", "Home", "wss://home.example");

  test("no broker is configured", () => {
    expect(brokerBinding([], "id-home")).toMatchObject({ broker: undefined, error: "No MQTT brokers configured" });
  });

  test("the node names no broker", () => {
    expect(brokerBinding([home], "")).toMatchObject({ broker: undefined, error: "Select a broker" });
  });

  test("the node names a broker that is not configured (any more)", () => {
    expect(brokerBinding([home], "id-gone")).toMatchObject({ broker: undefined, error: "Select a broker" });
  });

  test("the broker it names is out of a browser's reach", () => {
    const tcp = broker("id-tcp", "Workshop", "mqtt://workshop.example:1883");
    const binding = brokerBinding([home, tcp], "id-tcp");
    expect(binding.broker).toBe(tcp);
    expect(binding.error).toBe(
      "Workshop is not reachable from a browser — use a ws:// or wss:// broker, or the desktop app.",
    );
  });

  test("nothing, for a broker in reach", () => {
    expect(brokerBinding([home], "id-home")).toMatchObject({ broker: home, error: undefined });
  });

  test("nothing, for a broker whose address is still blank", () => {
    const blank = broker("id-blank", "New", "");
    expect(brokerBinding([blank], "id-blank").error).toBeUndefined();
  });
});

describe("the brokers a node depends on", () => {
  const node = (data: Record<string, unknown>): FlowNode => ({ id: "n", type: "Mqtt", position: { x: 0, y: 0 }, data });

  test("is the broker it names", () => {
    expect(brokerIds(node({ brokerId: "id-home" }))).toEqual(["id-home"]);
  });

  test("is none while it names no broker", () => {
    expect(brokerIds(node({ brokerId: "" }))).toEqual([]);
    expect(brokerIds(node({}))).toEqual([]);
  });
});
