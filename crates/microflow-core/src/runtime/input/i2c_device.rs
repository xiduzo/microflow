//! I2C Device Component - Input
//!
//! Generic I2C device node that can read from and write to any I2C peripheral.
//! Uses Firmata's I2C protocol via the [`BoardWriter`](crate::runtime::BoardWriter) surface.
//!
//! ## Lifecycle
//! 1. `initialize()` — Sends `I2C_CONFIG`, then writes the register address and
//!    starts a continuous read for the configured number of bytes.
//! 2. The runtime's inbound path drains `I2cReply` frames and routes them here
//!    via the typed `HardwareComponent::on_i2c_reply` callback (see `CONTEXT.md`
//!    § Hardware Callback).

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent,
    I2cContinuousRead, ListenerWiring, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
// The web sends camelCase keys (e.g. `readLength`); without this the multi-word
// fields silently fell back to their defaults (read_length stuck at 2 — the UI
// byte count was ignored). Single-word fields are unaffected.
#[serde(rename_all = "camelCase")]
pub struct I2cDeviceConfig {
    #[serde(default = "default_address")]
    pub address: u8,
    #[serde(default)]
    pub register: u8,
    #[serde(default = "default_read_length")]
    pub read_length: u8,
    #[serde(default = "default_freq")]
    pub freq: u32,
    #[serde(default = "default_device")]
    pub device: String,
    #[serde(default)]
    pub output: OutputFormat,
}

fn default_address() -> u8 {
    0x48
}
fn default_read_length() -> u8 {
    2
}
fn default_freq() -> u32 {
    100
}
fn default_device() -> String {
    "custom".to_string()
}

impl Default for I2cDeviceConfig {
    fn default() -> Self {
        Self {
            address: default_address(),
            register: 0,
            read_length: default_read_length(),
            freq: default_freq(),
            device: default_device(),
            output: OutputFormat::default(),
        }
    }
}

/// Normalise a device id to lowercase-alphanumeric. Older flows persisted the
/// leva *label* ("TCS34725") rather than the preset id ("tcs34725") before the
/// options-orientation fix; normalising lets `device_init_writes` match either.
fn normalize_device(device: &str) -> String {
    device.chars().filter(char::is_ascii_alphanumeric).flat_map(char::to_lowercase).collect()
}

pub struct I2cDevice {
    base: ComponentBase,
    config: I2cDeviceConfig,
    initialized: bool,
}

impl I2cDevice {
    #[must_use]
    pub fn new(id: String, config: I2cDeviceConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            initialized: false,
        }
    }

    /// Convert raw I2C reply bytes to a `ComponentValue` based on the output format.
    fn convert_bytes(&self, data: &[u8]) -> ComponentValue {
        match self.config.output {
            OutputFormat::Raw => ComponentValue::Array(
                data.iter().map(|&b| ComponentValue::Number(f64::from(b))).collect(),
            ),
            OutputFormat::UnsignedInt => {
                // Big-endian unsigned integer from up to 4 bytes
                let mut value: u32 = 0;
                for &byte in data.iter().take(4) {
                    value = (value << 8) | u32::from(byte);
                }
                ComponentValue::Number(f64::from(value))
            }
            OutputFormat::SignedInt => {
                // Big-endian signed integer (two's complement) from up to 4 bytes
                let len = data.len().min(4);
                if len == 0 {
                    return ComponentValue::Number(0.0);
                }
                let mut value: i32 = if data[0] & 0x80 != 0 { -1 } else { 0 };
                for &byte in data.iter().take(len) {
                    value = (value << 8) | i32::from(byte);
                }
                ComponentValue::Number(f64::from(value))
            }
        }
    }

    /// One-time I2C writes a known device needs before it produces data, keyed
    /// off the `device` preset id so `custom` and every other sensor are left
    /// untouched. Each entry is the raw payload `[register, value, …]` sent once
    /// in `initialize()`.
    fn device_init_writes(&self) -> &'static [&'static [u8]] {
        match normalize_device(&self.config.device).as_str() {
            // TCS34725 colour sensor: ENABLE register (0x00 | command-bit 0x80)
            // = PON | AEN (0x03), which powers the ADC. Without it every colour
            // register reads 0.
            "tcs34725" => &[&[0x80, 0x03]],
            // SHT21/HTU21: write the user register (0xE6) to drop measurement
            // resolution to 11-bit. 0x83 = resolution bits D7|D0 set, with the
            // power-on default's reserved bit1 (0x02) preserved. The faster
            // ~11ms conversion fits the I2C read-delay so the no-hold read (0xF3/
            // 0xF5) lands after it — full 14-bit (85ms) would exceed the 65ms cap.
            "sht21temp" | "sht21humidity" => &[&[0xE6, 0x83]],
            _ => &[],
        }
    }

    /// The register actually streamed, with a safety override: an SHT2x/HTU21
    /// node whose persisted `register` is a **hold-master** trigger (0xE3 temp /
    /// 0xE5 humidity) is remapped to its **no-hold** equivalent (0xF3 / 0xF5).
    ///
    /// Hold-master clock-stretches through the conversion, which on a classic AVR
    /// (no `Wire` timeout) HANGS the shared I2C bus and takes every other device
    /// down with it — it must never reach the board. Presets now store 0xF3/0xF5,
    /// but a flow saved before that change keeps the old value in its Yjs doc
    /// (leva doesn't rewrite a stored field when the preset definition changes),
    /// so we can't rely on the persisted register alone. Remapping here (and in
    /// the codegen twin) makes those stale docs safe without a migration, while
    /// leaving every non-SHT device's register untouched for custom use.
    ///
    /// Keyed on the device id OR the SHT2x/HTU21 bus address (0x40): a hold-master
    /// trigger sent to 0x40 is always an SHT2x and always unsafe, so this also
    /// protects a node left on `Custom` but pointed at 0x40 with a stale 0xE3/0xE5.
    fn effective_register(&self) -> u8 {
        let is_sht2x =
            normalize_device(&self.config.device).starts_with("sht21") || self.config.address == 0x40;
        if is_sht2x {
            match self.config.register {
                0xE3 => 0xF3,
                0xE5 => 0xF5,
                other => other,
            }
        } else {
            self.config.register
        }
    }

    /// Send a one-shot I2C read: write register address, then read N bytes.
    fn request_read(&self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // Write the register address first (sets the device's internal pointer).
        // Use the no-hold-safe register so a stale hold-master SHT2x value can't
        // hang the bus (see `effective_register`).
        let register = self.effective_register();
        if register != 0 {
            ctx.board().i2c_write(i32::from(self.config.address), &[register])?;
        }
        // Request a read
        ctx.board()
            .i2c_read(i32::from(self.config.address), i32::from(self.config.read_length))?;
        Ok(())
    }
}

impl Component for I2cDevice {
    fn ports() -> &'static [&'static str] {
        &["write", "trigger"]
    }

    fn emits() -> &'static [&'static str] {
        &[ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "I2cDevice"
    }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::I2cAddress { address: self.config.address }]
    }

    /// Stream rate for this device. The runtime reconciles it against every
    /// other component's hint and sets the board's single global sampling
    /// interval to the MAX — see `Component::sampling_interval_hint`. Setting it
    /// per-node in `initialize` instead let the last-initialized I2C node win,
    /// out-pacing a slower sensor's conversion (it read before data was ready).
    fn sampling_interval_hint(&self) -> Option<u32> {
        Some(self.config.freq)
    }

    /// No-hold SHT2x/HTU21 measurements NACK until the conversion completes, so
    /// the board must pause between the register write and the read. At 11-bit
    /// (`device_init_writes` → user reg 0x83) the worst-case conversion is RH 15ms
    /// / T 11ms, so 16ms covers both. Firmata's I2C_CONFIG delay is two **7-bit**
    /// sysex bytes → it caps at 16383 µs (≈16.4ms); 16000 sits just under that.
    /// (The 11/11-bit pair is the only one whose *both* conversions fit the cap —
    /// the next-coarser RH step pairs with 12-bit T at 22ms, over the limit.)
    /// Other devices read immediately. Reconciled to the MAX across components —
    /// it is a single global setting.
    fn i2c_read_delay_us(&self) -> Option<u32> {
        normalize_device(&self.config.device).starts_with("sht21").then_some(16_000)
    }

    /// The continuous read this node streams. Armed centrally by the runtime
    /// (stop-all-then-start-all in `update_flow`), never per-node — see
    /// [`I2cContinuousRead`]. Uses the no-hold-safe `effective_register` so a
    /// stale hold-master SHT2x register can't reach the bus.
    fn i2c_continuous_read(&self) -> Option<I2cContinuousRead> {
        Some(I2cContinuousRead {
            address: self.config.address,
            register: self.effective_register(),
            length: self.config.read_length,
        })
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "write" => {
                // Write data to the I2C device. Input can be a number or array of numbers.
                let mut data = vec![self.config.register];
                match &args {
                    ComponentValue::Number(n) => {
                        data.push(*n as u8);
                    }
                    ComponentValue::Array(arr) => {
                        for v in arr {
                            if let Some(n) = v.as_number() {
                                data.push(n as u8);
                            }
                        }
                    }
                    _ => {}
                }
                ctx.board().i2c_write(i32::from(self.config.address), &data)?;
                self.base.emit(ComponentBase::VALUE_HANDLE);
                Ok(())
            }
            "trigger" => {
                // One-shot read triggered by command handle
                self.request_read(ctx)?;
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!(
                "I2cDevice: unknown method '{method}'"
            ))),
        }
    }

    fn destroy(&mut self) {
        // The board is no longer held by the node; the I2C stop-reading command
        // cannot be issued here (destroy has no `ctx`). Reporting/reads are
        // reconciled centrally by the runtime when this node leaves the flow.
        self.initialized = false;
    }
}

impl HardwareComponent for I2cDevice {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // I2C bus enable + read-delay is a single GLOBAL Firmata setting, so it
        // is reconciled centrally (to the MAX `i2c_read_delay_us` across nodes)
        // in `update_flow` BEFORE this runs — not per-node here, where the last
        // node would win and could zero a no-hold sensor's required delay.

        self.initialized = true;

        // Power on / configure known devices (e.g. the TCS34725 ADC, or the
        // SHT2x resolution register) before the first read, so the very first
        // reply already carries live data.
        for &payload in self.device_init_writes() {
            ctx.board().i2c_write(i32::from(self.config.address), payload)?;
        }

        // The board's report-loop period (which clocks continuous I2C reads) is
        // a single GLOBAL Firmata setting, so it is NOT set here per-node — the
        // runtime reconciles it to the MAX of every component's
        // `sampling_interval_hint` in `update_flow`. Setting it here let the
        // last-initialized node win and out-pace a slower sensor.

        // Stream, don't poll: the board re-reads the register and pushes an
        // `I2C_REPLY` every sampling interval on its own. The continuous read is
        // NOT armed here per-node — it is armed CENTRALLY by the runtime (all
        // stops, then all starts) in `update_flow` via `i2c_continuous_read`,
        // because StandardFirmata's `I2C_STOP_READING` clears the lone remaining
        // query regardless of address: a per-node stop+start would drop a sibling
        // device the moment a second sensor registers on the shared bus.
        Ok(())
    }

    fn on_i2c_reply(
        &mut self,
        value: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        // value is an Array of byte values from the I2C-reply Hardware Callback.
        if let ComponentValue::Array(bytes) = &value {
            let raw: Vec<u8> = bytes
                .iter()
                .filter_map(|v| v.as_number().map(|n| n as u8))
                .collect();

            let converted = self.convert_bytes(&raw);
            // `set_value` already emits "value" on change; a second explicit
            // emit would re-fire on every poll (even when unchanged) now that
            // the emit layer no longer value-dedupes.
            self.base.set_value(converted);

            // No re-request here: the board streams these replies on its own
            // (continuous read armed in `initialize`), so each reply is purely a
            // value update.
        }
        Ok(())
    }
}

impl ComponentBuilder for I2cDevice {
    type Config = I2cDeviceConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(device: &str) -> I2cDevice {
        let config = I2cDeviceConfig { device: device.to_string(), ..Default::default() };
        I2cDevice::new("d-1".to_string(), config)
    }

    #[test]
    fn normalizes_stale_device_label_to_preset_id() {
        // Pre-fix flows persisted the leva label; it must map to the preset id.
        assert_eq!(normalize_device("TCS34725"), "tcs34725");
        assert_eq!(normalize_device("tcs34725"), "tcs34725");
        assert_eq!(normalize_device("custom"), "custom");
    }

    #[test]
    fn tcs34725_enable_write_fires_for_label_or_id() {
        // Whether the node stored the id ("tcs34725") or the stale label
        // ("TCS34725"), the ADC-enable write must be issued, else reads are all 0.
        for id in ["tcs34725", "TCS34725"] {
            let writes = device(id).device_init_writes();
            assert_eq!(writes.len(), 1, "device {id} must enable the ADC");
            assert_eq!(writes[0].to_vec(), vec![0x80u8, 0x03]);
        }
    }

    #[test]
    fn custom_device_emits_no_init_writes() {
        assert!(device("custom").device_init_writes().is_empty());
    }

    #[test]
    fn sht21_drops_resolution_and_requests_read_delay() {
        // No-hold SHT2x reads need (1) a one-time user-register write to 11-bit so
        // the conversion fits the delay, and (2) a non-zero read-delay so the read
        // lands after the conversion. Both temp and humidity presets qualify.
        for id in ["sht21_temp", "sht21_humidity"] {
            let dev = device(id);
            assert_eq!(
                dev.device_init_writes().iter().map(|p| p.to_vec()).collect::<Vec<_>>(),
                vec![vec![0xE6u8, 0x83]],
                "device {id} must drop resolution via the user register",
            );
            assert_eq!(dev.i2c_read_delay_us(), Some(16_000), "device {id} needs a read-delay");
            // Must stay within Firmata's 7-bit I2C_CONFIG cap (16383 µs).
            assert!(dev.i2c_read_delay_us().unwrap() <= 16_383, "delay exceeds the sysex cap");
        }
    }

    #[test]
    fn sht21_hold_master_register_is_remapped_to_no_hold() {
        // A flow saved before the no-hold preset change keeps 0xE3/0xE5 in its
        // doc; those hold-master triggers hang the AVR bus, so they must be
        // remapped to the no-hold equivalents before reaching the board.
        let reg = |device: &str, register: u8| {
            let config =
                I2cDeviceConfig { device: device.to_string(), register, ..Default::default() };
            I2cDevice::new("d-1".to_string(), config).effective_register()
        };
        assert_eq!(reg("sht21_temp", 0xE3), 0xF3, "stale hold-master temp -> no-hold");
        assert_eq!(reg("sht21_humidity", 0xE5), 0xF5, "stale hold-master humidity -> no-hold");
        // Already-correct no-hold registers pass through unchanged.
        assert_eq!(reg("sht21_temp", 0xF3), 0xF3);
        // A non-SHT device at a non-SHT address (default 0x48) is never rewritten,
        // even if its register happens to collide with a hold-master value.
        assert_eq!(reg("custom", 0xE3), 0xE3);
        assert_eq!(reg("tcs34725", 0xE5), 0xE5);

        // Broadened guard: a node left on `Custom` but pointed at the SHT2x bus
        // address (0x40) with a stale hold-master reg is still protected — that
        // combination only ever hits an SHT2x and would otherwise hang the bus.
        let reg_at = |address: u8, register: u8| {
            let config = I2cDeviceConfig {
                device: "custom".to_string(),
                address,
                register,
                ..Default::default()
            };
            I2cDevice::new("d-1".to_string(), config).effective_register()
        };
        assert_eq!(reg_at(0x40, 0xE3), 0xF3, "custom@0x40 hold-master -> no-hold");
        assert_eq!(reg_at(0x40, 0xE5), 0xF5);
        assert_eq!(reg_at(0x48, 0xE3), 0xE3, "non-0x40 custom untouched");
    }

    #[test]
    fn non_sht_devices_request_no_read_delay() {
        // A read-delay is global; only no-hold sensors should raise it. Everything
        // else reads immediately (the TCS/BME/etc. would just be slowed for free).
        for id in ["custom", "tcs34725", "bme280_temp"] {
            assert_eq!(device(id).i2c_read_delay_us(), None, "device {id} must not delay reads");
        }
    }

    #[test]
    fn output_format_accepts_stale_leva_labels() {
        // Canonical values and the human labels older flows persisted both decode.
        let parse = |s: &str| serde_json::from_str::<OutputFormat>(s).unwrap();
        assert_eq!(parse("\"raw\""), OutputFormat::Raw);
        assert_eq!(parse("\"Raw bytes\""), OutputFormat::Raw);
        assert_eq!(parse("\"unsigned_int\""), OutputFormat::UnsignedInt);
        assert_eq!(parse("\"Unsigned int\""), OutputFormat::UnsignedInt);
        assert_eq!(parse("\"Signed int\""), OutputFormat::SignedInt);
    }

    #[test]
    fn config_survives_camelcase_keys_and_stale_label_output() {
        // Exactly what the web sends for a stale TCS node: camelCase `readLength`,
        // label-valued `output`/`device`. Must NOT silently fall back to defaults
        // (which would point reads at 0x48 and skip the ADC enable).
        let cfg: I2cDeviceConfig = serde_json::from_value(serde_json::json!({
            "address": 0x29,
            "register": 0xB4,
            "readLength": 8,
            "output": "Raw bytes",
            "device": "TCS34725",
            "freq": 50,
        }))
        .unwrap();
        assert_eq!(cfg.address, 0x29);
        assert_eq!(cfg.read_length, 8);
        assert_eq!(cfg.output, OutputFormat::Raw);
        assert_eq!(cfg.freq, 50);
    }
}
