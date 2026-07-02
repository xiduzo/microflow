export type I2cPreset = {
  label: string;
  address: number;
  register: number;
  readLength: number;
  output: "raw" | "unsigned_int" | "signed_int";
  // Recommended stream interval (ms). Drives the board's Firmata sampling
  // interval — see runtime/input/i2c_device.rs. Each sensor has a natural floor
  // (conversion/integration time + bytes-per-read over the serial link); below
  // it the read fires before data is ready and reports stale/zero values.
  // NOTE: the sampling interval is GLOBAL to the board, so with multiple I2C
  // nodes the last one to initialize wins — pick the slowest sensor's value.
  freq: number;
  description: string;
};

export const I2C_PRESETS: Record<string, I2cPreset> = {
  custom: {
    label: "Custom",
    address: 0x48,
    register: 0x00,
    readLength: 2,
    output: "unsigned_int",
    freq: 100,
    description: "Manual I2C configuration",
  },
  bh1750: {
    label: "BH1750",
    address: 0x23,
    register: 0x10,
    readLength: 2,
    output: "unsigned_int",
    // H-resolution mode needs ~120ms per measurement.
    freq: 180,
    description: "Light sensor (lux)",
  },
  bme280_temp: {
    label: "BME280 (temp)",
    address: 0x76,
    register: 0xfa,
    readLength: 3,
    output: "unsigned_int",
    freq: 100,
    description: "Temperature sensor",
  },
  bme280_humidity: {
    label: "BME280 (humidity)",
    address: 0x76,
    register: 0xfd,
    readLength: 2,
    output: "unsigned_int",
    freq: 100,
    description: "Humidity (raw ADC — compensate downstream)",
  },
  bmp280_temp: {
    label: "BMP280 (temp)",
    // BMP280 = the humidity-less BME280 (temp + pressure only). Same 0x76 default
    // address (0x77 if SDO is tied high) and the same ctrl_meas/config startup —
    // the runtime wakes it to NORMAL mode. 0xFA = temp_msb, 3 bytes = raw 20-bit.
    address: 0x76,
    register: 0xfa,
    readLength: 3,
    output: "unsigned_int",
    freq: 100,
    description: "Temperature (raw ADC — compensate downstream)",
  },
  bmp280_pressure: {
    label: "BMP280 (pressure)",
    address: 0x76,
    // 0xF7 = press_msb, 3 bytes = raw 20-bit pressure ADC.
    register: 0xf7,
    readLength: 3,
    output: "unsigned_int",
    freq: 100,
    description: "Pressure (raw ADC — compensate downstream)",
  },
  sht21_temp: {
    label: "SHT21/HTU21 (temp)",
    address: 0x40,
    // 0xF3 = trigger temp measure, NO-HOLD master. Hold-master (0xE3) clock-
    // stretches through the conversion, which HANGS the AVR I2C bus (no Wire
    // timeout) and takes every other device down with it. No-hold NACKs the read
    // until the conversion is done instead. The runtime drops the sensor to
    // 11-bit (user-register write, ~11ms) and waits an I2C read-delay so the read
    // lands after conversion. readLength 2 = the 16-bit value, CRC byte skipped.
    register: 0xf3,
    readLength: 2,
    output: "unsigned_int",
    freq: 120,
    description: "Temperature (11-bit, raw 16-bit — scale downstream)",
  },
  sht21_humidity: {
    label: "SHT21/HTU21 (humidity)",
    address: 0x40,
    // 0xF5 = trigger humidity measure, no-hold (see sht21_temp).
    register: 0xf5,
    readLength: 2,
    output: "unsigned_int",
    freq: 120,
    description: "Humidity (11-bit, raw 16-bit — scale downstream)",
  },
  mpu6050_accel: {
    label: "MPU6050 (accel)",
    address: 0x68,
    register: 0x3b, // ACCEL_XOUT_H — 6 bytes = accel X/Y/Z
    readLength: 6,
    output: "raw",
    freq: 20,
    // Runtime clears the SLEEP bit (PWR_MGMT_1) on startup, else all axes read 0.
    // Accel + gyro are the same chip at 0x68; the reply demux (by register) keeps
    // the two nodes' streams separate — see runtime/mod.rs::drain_i2c_replies.
    description: "Accelerometer XYZ (auto-woken)",
  },
  mpu6050_gyro: {
    label: "MPU6050 (gyro)",
    address: 0x68,
    register: 0x43, // GYRO_XOUT_H — 6 bytes = gyro X/Y/Z
    readLength: 6,
    output: "raw",
    freq: 20,
    description: "Gyroscope XYZ (auto-woken)",
  },
  vl53l0x: {
    label: "VL53L0X",
    address: 0x29,
    register: 0x14,
    readLength: 2,
    output: "unsigned_int",
    freq: 60,
    // NOTE: unlike the others, the VL53L0X can't be brought up by a static write
    // list — ranging needs ST's full driver init. This preset reads the range
    // register but the sensor must be initialised externally. See docs/I2C_SUPPORT.md.
    description: "Distance (mm — needs external init, see docs)",
  },
  tcs34725: {
    label: "TCS34725",
    address: 0x29,
    // 0xA0 | 0x14: command bit + auto-increment from CDATAL, so 8 bytes
    // stream out as C,R,G,B (each low-byte-first). Parse little-endian pairs.
    register: 0xb4,
    readLength: 8,
    output: "raw",
    // 8-byte reads are flaky below ~100ms over the serial link; give headroom.
    freq: 120,
    description: "RGB color sensor (raw C,R,G,B — needs ENABLE write)",
  },
} as const;

// Leva reads option objects as { [label]: value } — Object.keys() are the
// labels shown, Object.values() are what onChange writes. So the value side
// must be the preset KEY (looked up in I2C_PRESETS) / the Rust config variant,
// never the human label, or the runtime rejects it (`unknown variant ...`).
export const I2C_DEVICE_OPTIONS = Object.fromEntries(
  Object.entries(I2C_PRESETS).map(([key, preset]) => [preset.label, key]),
);

export const I2C_OUTPUT_OPTIONS = {
  "Raw bytes": "raw",
  "Unsigned int": "unsigned_int",
  "Signed int": "signed_int",
} as const;
