//! I2C device *preset knowledge* — the single source shared by the live runtime
//! (`runtime/input/i2c_device.rs`, interpret) and the codegen emitter
//! (`codegen/input/i2c_device.rs`, compile to C++).
//!
//! A known sensor's power-on/config writes and its hold-master register remap are
//! pure datasheet facts: they must be byte-identical whether a flow runs live or
//! is exported as an Arduino sketch. They used to be hand-mirrored in both files
//! and drifted — codegen matched the raw `device` id while the runtime normalised
//! it, so a stale leva label ("TCS34725") self-initialised live but NOT in the
//! generated sketch. Keeping the table here once, **ungated** (no `runtime`
//! feature — codegen must reach it), makes that drift impossible: adding a sensor
//! is one edit, and both sides pick it up.
//!
//! ## What counts as a "startup sequence"
//! A list of raw `[register, value, …]` payloads written once, in order, before
//! the first read. There is deliberately no inter-write delay here (the model is
//! a flat list), so a device whose init needs timed steps — notably the VL53L0X,
//! which wants ST's stateful tuning-blob + calibration sequence — is left with an
//! empty list and documented as needing a dedicated driver.
//!
//! ## Config struct
//! [`I2cDeviceConfig`] and [`OutputFormat`] live here too (ungated) so codegen
//! can deserialize the SAME struct the runtime builds from, instead of
//! re-parsing the node JSON field-by-field with its own duplicated defaults —
//! which drifted (see `codegen/input/i2c_device.rs`).

use serde::{Deserialize, Serialize};

/// How the raw I2C reply bytes are decoded into a value.
///
/// # Decode contract (the single authority both interpreters consume)
/// Each variant maps to one [`ByteDecode`] descriptor via [`OutputFormat::decode`].
/// The live runtime *interprets* the descriptor over received bytes
/// (`runtime/input/i2c_device.rs` → [`fold_bytes`], producing a `ComponentValue`)
/// and the sketch emitter *transcribes* it to a C++ fold
/// (`codegen/input/i2c_device.rs`, producing a `long`). The two languages cannot
/// share executable code, so the arithmetic/branching lives here ONCE and the
/// `codegen/parity.rs` `I2cDevice` case pins the emitted C++ to the descriptor.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    // The `alias`es accept the human labels older flows persisted as the field
    // value (before the leva options-orientation fix), so a stale `"Raw bytes"`
    // still decodes to `Raw` instead of erroring the whole config back to default.
    #[serde(alias = "Raw bytes")]
    Raw,
    #[default]
    #[serde(alias = "Unsigned int")]
    UnsignedInt,
    #[serde(alias = "Signed int")]
    SignedInt,
}

/// The decode an [`OutputFormat`] applies to the raw reply bytes — the shared
/// descriptor both consumers derive from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteDecode {
    /// Every byte preserved, in order. The runtime yields an array; the sketch
    /// has no byte-array value model and folds like `Fold { sign_extend: false }`
    /// — the closest single-value approximation, recorded in `codegen/parity.rs`.
    Raw,
    /// Big-endian shift-or of at most [`OutputFormat::FOLD_BYTE_CAP`] bytes into
    /// a 32-bit value; trailing bytes are read off the bus but ignored.
    /// `sign_extend` seeds the accumulator two's-complement from bit 7 of the
    /// FIRST (most-significant) byte.
    Fold { sign_extend: bool },
}

impl OutputFormat {
    /// At most this many reply bytes fold into the value — the 32-bit
    /// accumulator width, on BOTH targets (runtime `u32`/`i32`, sketch `long`).
    pub const FOLD_BYTE_CAP: usize = 4;

    /// The decode descriptor this format performs.
    #[must_use]
    pub fn decode(self) -> ByteDecode {
        match self {
            Self::Raw => ByteDecode::Raw,
            Self::UnsignedInt => ByteDecode::Fold { sign_extend: false },
            Self::SignedInt => ByteDecode::Fold { sign_extend: true },
        }
    }
}

/// Interpret a [`ByteDecode::Fold`] over received bytes — the runtime's live
/// decode, and the reference the emitted C++ fold transcribes: big-endian
/// shift-or of the first [`OutputFormat::FOLD_BYTE_CAP`] bytes, optionally
/// sign-extended from bit 7 of the first byte. Empty input decodes to 0.
#[must_use]
pub fn fold_bytes(sign_extend: bool, data: &[u8]) -> f64 {
    let data = &data[..data.len().min(OutputFormat::FOLD_BYTE_CAP)];
    if sign_extend {
        let mut value: i32 = match data.first() {
            Some(&msb) if msb & 0x80 != 0 => -1,
            _ => 0,
        };
        for &byte in data {
            value = (value << 8) | i32::from(byte);
        }
        f64::from(value)
    } else {
        let mut value: u32 = 0;
        for &byte in data {
            value = (value << 8) | u32::from(byte);
        }
        f64::from(value)
    }
}

/// Deserialized configuration for the generic `I2cDevice` node. Ungated (no
/// `runtime` feature) so both the interpreter and the emitter read one struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
// The web sends camelCase keys (e.g. `readLength`); without `rename_all` the
// multi-word fields silently fell back to their defaults (read_length stuck at 2 —
// the UI byte count was ignored). Container-level `default` fills EVERY missing
// field from `Self::default()` below — the single source of field defaults — so a
// partial doc (or `{}`, or a pre-`autoread` flow) deserializes to exactly the
// `Default` values, with no per-field `default = "fn"` copies to keep in sync.
#[serde(rename_all = "camelCase", default)]
pub struct I2cDeviceConfig {
    pub address: u8,
    pub register: u8,
    pub read_length: u8,
    /// Board sampling-interval **period in milliseconds** for this device's
    /// continuous read — NOT a frequency, despite the name older flows persist.
    /// Reconciled to the MAX across all I2C nodes via `Component::board_wiring`.
    /// The web still writes the key `freq`, so the wire name is kept via
    /// `serde(rename)` for doc compatibility.
    #[serde(rename = "freq")]
    pub sample_interval_ms: u32,
    pub device: String,
    pub output: OutputFormat,
    /// Stream on the board's sampling interval (`true`, default) vs. read only
    /// when the `trigger` command handle fires (`false`). When off, no continuous
    /// read is armed — `board_wiring().i2c_continuous_read` is `None` — so the bus
    /// stays quiet until a one-shot `trigger` requests a read.
    pub autoread: bool,
}

impl Default for I2cDeviceConfig {
    fn default() -> Self {
        Self {
            address: 0x48,
            register: 0,
            read_length: 2,
            sample_interval_ms: 100,
            device: "custom".to_string(),
            output: OutputFormat::default(),
            autoread: true,
        }
    }
}

/// Normalise a device id to lowercase-alphanumeric. Older flows persisted the
/// leva *label* ("TCS34725") rather than the preset id ("tcs34725") before the
/// options-orientation fix; normalising lets the tables below match either, and
/// strips the `_` in `sht21_temp`/`bme280_temp` so the arms read cleanly.
#[must_use]
pub fn normalize_device(device: &str) -> String {
    device.chars().filter(char::is_ascii_alphanumeric).flat_map(char::to_lowercase).collect()
}

/// One-time I2C writes a known device needs before it produces data, keyed off
/// the normalised `device` preset id so `custom` and any unrecognised id are left
/// untouched. Each entry is the raw payload `[register, value, …]` sent once in
/// the runtime's `initialize()` / the sketch's `setup()`.
///
/// Every arm here is a device the docs call "advanced": without the write the
/// sensor sits in a reset/sleep/single-shot state and every read returns a
/// constant (0, or the reset value), which reads as a dead sensor.
#[must_use]
pub fn device_init_writes(device: &str) -> &'static [&'static [u8]] {
    match normalize_device(device).as_str() {
        // TCS34725 colour sensor: ENABLE register (0x00 | command-bit 0x80) =
        // PON | AEN (0x03), which powers the ADC. Without it every colour register
        // reads 0.
        "tcs34725" => &[&[0x80, 0x03]],
        // SHT21/HTU21: write the user register (0xE6) to drop measurement
        // resolution to 11-bit. 0x83 = resolution bits D7|D0 set, with the
        // power-on default's reserved bit1 (0x02) preserved. The faster ~11ms
        // conversion fits the I2C read-delay so the no-hold read (0xF3/0xF5) lands
        // after it — full 14-bit (85ms) would exceed the delay cap.
        "sht21temp" | "sht21humidity" => &[&[0xE6, 0x83]],
        // MPU6050 accel (0x3B) / gyro (0x43): one chip at 0x68, two presets
        // (`mpu6050_accel` / `mpu6050_gyro`) plus any legacy `mpu6050` id. It
        // powers up ASLEEP (PWR_MGMT_1 0x6B has the SLEEP bit set), so every
        // ACCEL_*/GYRO_* register reads 0. Writing 0x6B = 0x00 clears SLEEP and
        // selects the internal 8MHz clock — the same wake serves both presets. The
        // power-on default ranges (±2g / ±250°/s) are fine for the raw burst reads.
        d if d.starts_with("mpu6050") => &[&[0x6B, 0x00]],
        // BME280 temp/humidity (one chip, two presets): powers up in SLEEP, so the
        // data registers stay pinned at their reset value. Bring it to NORMAL mode.
        // ctrl_hum (0xF2) MUST be written BEFORE ctrl_meas (0xF4) or the humidity
        // oversampling never latches (datasheet §5.4.3).
        //   0xF2 = 0x01 -> humidity oversampling x1
        //   0xF4 = 0x27 -> temp x1 (001) | press x1 (001) | mode NORMAL (11)
        //   0xF5 = 0xA0 -> t_standby 1000ms (101) | IIR filter off | 3-wire off
        // NB: the 0xFA/0xFD reads are still *uncompensated* ADC counts — real
        // degC/%RH needs the per-chip calibration + Bosch compensation applied
        // downstream. This only makes the raw registers live instead of static.
        "bme280temp" | "bme280humidity" => &[&[0xF2, 0x01], &[0xF4, 0x27], &[0xF5, 0xA0]],
        // BMP280 temp/pressure (one chip, two presets): the humidity-less sibling
        // of the BME280 — same sleep-on-power-up, same ctrl_meas/config registers,
        // but NO ctrl_hum (0xF2) register, so it is omitted here. Same NORMAL-mode
        // config as the BME280; the 0xFA (temp) / 0xF7 (press) reads are likewise
        // raw uncompensated 20-bit ADC counts, compensated downstream.
        "bmp280temp" | "bmp280pressure" => &[&[0xF4, 0x27], &[0xF5, 0xA0]],
        // BH1750 ambient-light sensor: opcode-driven, no registers. After power-up
        // it sits in POWER-DOWN; send POWER-ON (0x01) so it is awake before the
        // continuous H-res mode command (0x10, the preset's "register") that the
        // read path re-issues each sampling cycle.
        "bh1750" => &[&[0x01]],
        // VL53L0X time-of-flight: intentionally EMPTY. Ranging needs ST's full
        // DataInit + StaticInit tuning blob (~80 device-specific register writes) +
        // reference-SPAD/temperature calibration + StartMeasurement — a stateful,
        // read-modify-write sequence that CANNOT be expressed as a static write
        // list. The 0x14 range read stays uninitialised; a real VL53L0X needs a
        // dedicated driver. See docs/I2C_SUPPORT.md.
        "vl53l0x" => &[],
        _ => &[],
    }
}

/// The register actually read, with a hold-master → no-hold safety override: an
/// SHT2x/HTU21 node whose persisted `register` is a hold-master trigger (0xE3 temp
/// / 0xE5 humidity) is remapped to its no-hold equivalent (0xF3 / 0xF5).
///
/// Hold-master clock-stretches through the conversion, which on a classic AVR (no
/// `Wire` timeout) HANGS the shared I2C bus and takes every other device down with
/// it — it must never reach the board. Presets now store 0xF3/0xF5, but a flow
/// saved before that change keeps the old value in its Yjs doc (leva doesn't
/// rewrite a stored field when the preset definition changes), so the persisted
/// register alone can't be trusted. Keyed on the device id OR the `SHT2x` bus address
/// (0x40): a hold-master trigger sent to 0x40 is always an `SHT2x` and always unsafe,
/// so this also protects a node left on `custom` but pointed at 0x40 with a stale
/// 0xE3/0xE5. Every non-SHT device's register is returned untouched.
#[must_use]
pub fn effective_register(device: &str, address: u8, register: u8) -> u8 {
    let is_sht2x = normalize_device(device).starts_with("sht21") || address == 0x40;
    if is_sht2x {
        match register {
            0xE3 => 0xF3,
            0xE5 => 0xF5,
            other => other,
        }
    } else {
        register
    }
}

/// Whether this device is a no-hold SHT2x/HTU21 measurement that NACKs until its
/// conversion completes, so the host must pause between the register write and the
/// read. The delay *magnitude* differs by target (the runtime is capped by
/// Firmata's 7-bit `I2C_CONFIG` sysex; the generated sketch uses a plain `delay()`),
/// so each side owns its own value — only this classification is shared.
#[must_use]
pub fn is_no_hold_sht2x(device: &str) -> bool {
    normalize_device(device).starts_with("sht21")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::float_cmp)] // every folded value is an exact integer in f64
    fn fold_bytes_is_big_endian_capped_and_sign_extends() {
        // Big-endian: MSB first (0x0102 = 258).
        assert_eq!(fold_bytes(false, &[0x01, 0x02]), 258.0);
        // High bit set stays positive unsigned, sign-extends signed.
        assert_eq!(fold_bytes(false, &[0xFF, 0xFF]), 65535.0);
        assert_eq!(fold_bytes(true, &[0xFF, 0xFF]), -1.0);
        assert_eq!(fold_bytes(true, &[0x00, 0x2A]), 42.0);
        // Empty decodes to 0, signed or not.
        assert_eq!(fold_bytes(true, &[]), 0.0);
        // Only the FIRST `FOLD_BYTE_CAP` bytes fold; trailing bytes are ignored.
        assert_eq!(fold_bytes(false, &[1, 2, 3, 4, 5]), f64::from(0x0102_0304_u32));
    }

    #[test]
    fn every_format_maps_to_its_decode_descriptor() {
        assert_eq!(OutputFormat::Raw.decode(), ByteDecode::Raw);
        assert_eq!(OutputFormat::UnsignedInt.decode(), ByteDecode::Fold { sign_extend: false });
        assert_eq!(OutputFormat::SignedInt.decode(), ByteDecode::Fold { sign_extend: true });
    }

    #[test]
    fn normalizes_stale_device_label_to_preset_id() {
        // Pre-fix flows persisted the leva label; it must map to the preset id.
        assert_eq!(normalize_device("TCS34725"), "tcs34725");
        assert_eq!(normalize_device("tcs34725"), "tcs34725");
        assert_eq!(normalize_device("SHT21_temp"), "sht21temp");
        assert_eq!(normalize_device("custom"), "custom");
    }

    #[test]
    fn custom_and_unknown_devices_have_no_init() {
        assert!(device_init_writes("custom").is_empty());
        assert!(device_init_writes("").is_empty());
        assert!(device_init_writes("totally-unknown").is_empty());
    }

    #[test]
    fn tcs34725_enables_the_adc_for_label_or_id() {
        // Whether the node stored the id or the stale label, the ENABLE write must
        // fire, else every colour register reads 0.
        for id in ["tcs34725", "TCS34725"] {
            assert_eq!(device_init_writes(id), &[&[0x80u8, 0x03][..]], "device {id}");
        }
    }

    #[test]
    fn sht21_drops_resolution_to_11_bit() {
        for id in ["sht21_temp", "sht21_humidity"] {
            assert_eq!(device_init_writes(id), &[&[0xE6u8, 0x83][..]], "device {id}");
            assert!(is_no_hold_sht2x(id), "device {id} needs a read-delay");
        }
    }

    #[test]
    fn mpu6050_wakes_from_sleep_for_both_presets() {
        // Boots asleep (PWR_MGMT_1 0x6B SLEEP set); 0x6B = 0x00 clears SLEEP. Accel
        // and gyro are the same chip, so both presets (and any legacy `mpu6050` id,
        // and a stale label) get the wake write.
        for id in ["mpu6050_accel", "mpu6050_gyro", "mpu6050", "MPU6050 (accel)"] {
            assert_eq!(device_init_writes(id), &[&[0x6Bu8, 0x00][..]], "device {id}");
        }
    }

    #[test]
    fn bme280_leaves_sleep_with_hum_before_meas() {
        // Same chip, two presets; ctrl_hum (0xF2) before ctrl_meas (0xF4).
        for id in ["bme280_temp", "bme280_humidity"] {
            let writes = device_init_writes(id);
            assert_eq!(
                writes,
                &[&[0xF2u8, 0x01][..], &[0xF4, 0x27][..], &[0xF5, 0xA0][..]],
                "device {id}",
            );
            let hum = writes.iter().position(|p| p[0] == 0xF2).unwrap();
            let meas = writes.iter().position(|p| p[0] == 0xF4).unwrap();
            assert!(hum < meas, "device {id}: ctrl_hum must precede ctrl_meas");
            assert_eq!(writes[meas][1] & 0b11, 0b11, "device {id}: mode must be NORMAL");
        }
    }

    #[test]
    fn bmp280_configures_meas_and_config_without_humidity() {
        // BMP280 has no humidity register, so — unlike the BME280 — it must NOT
        // emit a ctrl_hum (0xF2) write, only ctrl_meas + config.
        for id in ["bmp280_temp", "bmp280_pressure"] {
            let writes = device_init_writes(id);
            assert_eq!(writes, &[&[0xF4u8, 0x27][..], &[0xF5, 0xA0][..]], "device {id}");
            assert!(
                writes.iter().all(|p| p[0] != 0xF2),
                "device {id}: BMP280 has no ctrl_hum register",
            );
            assert_eq!(writes[0][1] & 0b11, 0b11, "device {id}: mode must be NORMAL");
        }
    }

    #[test]
    fn bh1750_powers_on() {
        assert_eq!(device_init_writes("bh1750"), &[&[0x01u8][..]]);
    }

    #[test]
    fn vl53l0x_ships_no_static_init() {
        // Can't be expressed as a static write list — none by design.
        assert!(device_init_writes("vl53l0x").is_empty());
    }

    #[test]
    fn sht21_hold_master_register_is_remapped_to_no_hold() {
        // Stale 0xE3/0xE5 would hang the AVR bus; remap to no-hold 0xF3/0xF5.
        assert_eq!(effective_register("sht21_temp", 0x40, 0xE3), 0xF3);
        assert_eq!(effective_register("sht21_humidity", 0x40, 0xE5), 0xF5);
        // Already-correct no-hold registers pass through.
        assert_eq!(effective_register("sht21_temp", 0x40, 0xF3), 0xF3);
        // A non-SHT device at a non-SHT address is never rewritten.
        assert_eq!(effective_register("custom", 0x48, 0xE3), 0xE3);
        assert_eq!(effective_register("tcs34725", 0x29, 0xE5), 0xE5);
        // Broadened guard: custom node pointed at the SHT2x bus address (0x40).
        assert_eq!(effective_register("custom", 0x40, 0xE3), 0xF3);
        assert_eq!(effective_register("custom", 0x40, 0xE5), 0xF5);
    }
}
