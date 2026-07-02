/**
 * THIS COMPONENT IS IN PROGRESS
 * it still requires a lot of testing before exposing it to users
 */

import { NodeHandles } from "../_base/node-handles";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { dataSchema, type Data, type Value } from "./i2c-device.schema";
import {
  I2C_PRESETS,
  I2C_DEVICE_OPTIONS,
  I2C_OUTPUT_OPTIONS,
} from "./i2c-device.constants";
import { folder } from "leva";

export function I2cDevice(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles
        instance="I2cDevice"
        portOverrides={{
          write: { handleType: "value", hint: "write bytes", offset: -0.5 },
          trigger: {
            handleType: "command",
            hint: "one-shot read",
            offset: 0.5,
          },
        }}
        emitOverrides={{ value: { handleType: "value" } }}
      />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(0);

  if (Array.isArray(value)) {
    return (
      <div className="font-mono text-xs text-muted-foreground">
        [{value.map((v) => v.toString()).join(", ")}]
      </div>
    );
  }

  return <div className="text-2xl font-light tabular-nums">{value}</div>;
}

function Settings() {
  const data = useNodeData<Data>();

  const { render, set, setNodeData } = useNodeControls({
    device: {
      value: data.device,
      options: I2C_DEVICE_OPTIONS,
      label: "device preset",
      onChange: (
        value: string,
        _path: string,
        context: { initial: boolean },
      ) => {
        if (context.initial) return;
        const preset = I2C_PRESETS[value];
        if (preset && value !== "custom") {
          setNodeData({
            device: value,
            address: preset.address,
            register: preset.register,
            readLength: preset.readLength,
            output: preset.output,
            freq: preset.freq,
          });
          set({
            address: preset.address,
            register: preset.register,
            readLength: preset.readLength,
            output: preset.output,
            freq: preset.freq,
          });
        }
      },
    },
    address: {
      value: data.address,
      min: 0,
      max: 255,
      step: 1,
      label: "address (dec)",
    },
    // On (default): the board streams reads on its sampling interval. Off: the
    // bus stays quiet until the `trigger` handle fires a one-shot read — see
    // `autoread` in runtime/input/i2c_device.rs.
    autoread: {
      // Pre-`autoread` docs omit the key; coerce to the streaming default so leva
      // can infer the boolean control (a raw `undefined` makes it drop silently).
      value: data.autoread ?? true,
      label: "auto-read",
    },
    config: folder(
      {
        register: {
          value: data.register,
          min: 0,
          max: 255,
          step: 1,
          label: "register (dec)",
        },
        readLength: {
          value: data.readLength,
          min: 1,
          max: 32,
          step: 1,
          label: "read bytes",
        },
        output: {
          value: data.output,
          options: I2C_OUTPUT_OPTIONS,
          label: "output format",
        },
        // The runtime maps this to the board's Firmata sampling interval, which
        // is the rate at which it streams continuous I2C reads back (no polling);
        // see `initialize` in runtime/input/i2c_device.rs. Global to the board.
        freq: {
          value: data.freq,
          min: 20,
          max: 5000,
          step: 10,
          label: "stream interval (ms)",
          // Only the streaming path uses the sampling interval; when reads are
          // trigger-driven there is nothing to pace. Default (absent key) = on.
          disabled: !(data.autoread ?? true),
        },
      },
      { collapsed: true },
    ),
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
I2cDevice.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "sense",
    tags: ["value", "source"],
    label: "I2C Device",
    icon: "CpuIcon",
    description:
      "Read from and write to I2C sensors like BME280, MPU6050, BH1750, and other I2C peripherals",
  } satisfies Props["data"],
};
