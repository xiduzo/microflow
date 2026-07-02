# TCS34725 via microflow I2C Device node (Firmata)

## Wiring (to your Firmata board)
- VIN → 5V (Uno) or 3V3 (ESP32)
- GND → GND
- SDA → board SDA (Uno A4 / ESP32 21 / Mega 20)
- SCL → board SCL (Uno A5 / ESP32 22 / Mega 21)
- 3v3, INT, LED → leave open (tie LED→GND to kill illumination LED)

I2C address = 0x29.

## TCS34725 protocol facts the generic node must respect
1. **Command bit**: every register access must OR 0x80.
   - Auto-increment read (multi-byte): `0xA0 | reg`.
2. **Must power on**: write ENABLE (reg 0x00) = 0x03 (PON|AEN). Defaults OFF → reads 0 otherwise.
3. **Data is little-endian**, 2 bytes/channel: C(0x14) R(0x16) G(0x18) B(0x1A).

## Reader node config (preset = Custom)
- address: 0x29
- register: 0xB4        # 0xA0 | 0x14 → auto-increment from CDATAL
- readLength: 8         # CL CH RL RH GL GH BL BH
- output: Raw           # → array of 8 bytes; UnsignedInt is big-endian, wrong here

Node continuously re-reads (re-points to 0xB4 each poll). Good.

## Parse 8 bytes → r,g,b,c  (Function node, value→trigger)
```js
// input = [CL,CH,RL,RH,GL,GH,BL,BH]
const c = input[0] + input[1]*256;
const r = input[2] + input[3]*256;
const g = input[4] + input[5]*256;
const b = input[6] + input[7]*256;
// normalize against clear for stable color regardless of brightness
const n = c > 0 ? 255/c : 0;
return { r, g, b, c, rn: Math.min(255, r*n), gn: Math.min(255, g*n), bn: Math.min(255, b*n) };
```

## The ENABLE problem (read this)
The reader node's `write` port writes to ITS OWN register (0xB4), so it can't send the
ENABLE write to reg 0x80. And reply routing is **by address only** — every node listening
on 0x29 gets every reply, with no register tag (core/src/runtime/mod.rs:580). So a second
always-on I2C node on 0x29 cross-talks with the reader and corrupts frames.

### Option A — prototype (works now, no code change)
1. Add a 2nd I2C node: address 0x29, register 0x80 (ENABLE+command bit).
2. Push the value 3 into its `write` port once (Constant node → write).
3. **Delete that node** after it fires. PON|AEN stay set until power-cycle, so the
   reader now returns valid color. Re-do after every reconnect/replug.

(optional extra init writes, same mechanism, before reading:)
- ATIME  reg 0x81 = 0xEB (~50ms integration; lower = longer = more counts)
- CONTROL reg 0x8F = 0x01 (4x gain; 0=1x,1=4x,2=16x,3=60x)

### Option B — proper fix (root-cause, matches house style)
Extend `I2cDeviceConfig` (crates/microflow-core/src/runtime/input/i2c_device.rs):
- `init_writes: Vec<(u8,u8)>` — (register,value) pairs sent once in `initialize()`
  before the first read. Lets one node power on + configure + read.
- `mode: Read | WriteOnly` — WriteOnly skips `request_read()` AND returns no
  `ListenerWiring::I2cAddress`, so a config/enable node never registers a reply
  listener and can't cross-talk on a shared address.
Mirror in codegen node + web schema/constants (add a `tcs34725` preset).

## Sanity check wiring before color
Temp node: register 0x92 (0x80|0x12 = ID reg), readLength 1, output Raw.
Expect 0x44 (68) for TCS34725 (or 0x4D). Non-zero, stable → bus is good.
