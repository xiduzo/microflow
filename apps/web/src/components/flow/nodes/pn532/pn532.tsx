/**
 * THIS COMPONENT IS IN PROGRESS
 * The live Firmata driver is unverified on hardware — the PN532 can clock-stretch
 * the I2C bus, the same failure mode that once wedged the AVR `Wire` bus for the
 * SHT21 hold-master read. See docs/PN532_NFC.md before relying on it.
 */

import { NodeHandles } from "../_base/node-handles";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { dataSchema, type Data, type Value } from "./pn532.schema";

export function Pn532(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles
        instance="Pn532"
        emitOverrides={{ value: { handleType: "value" } }}
      />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>("");

  if (!value) {
    return <div className="text-sm text-muted-foreground">no card</div>;
  }

  return <div className="font-mono text-xl tabular-nums">{value}</div>;
}

function Settings() {
  const data = useNodeData<Data>();

  const { render } = useNodeControls({
    address: {
      value: data.address,
      min: 0,
      max: 255,
      step: 1,
      label: "address (dec)",
    },
    pollIntervalMs: {
      value: data.pollIntervalMs,
      min: 50,
      max: 10000,
      step: 10,
      label: "poll interval (ms)",
    },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Pn532.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "sense",
    tags: ["value", "source"],
    label: "NFC Reader",
    icon: "NfcIcon",
    description:
      "Read an NFC/RFID card UID over I2C with a PN532 module (I2C address 0x24)",
  } satisfies Props["data"],
};
