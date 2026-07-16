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
    BoardWiring, Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent,
    I2cContinuousRead, ListenerWiring, RuntimeContext, RuntimeError,
};
use crate::config::i2c_device::{I2cDeviceConfig, OutputFormat};

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

    /// One-time I2C writes this device needs before it produces data. Thin wrapper
    /// over the ungated [`crate::config::i2c_device::device_init_writes`] table so
    /// the live runtime and the generated sketch stay byte-identical — sent once in
    /// `initialize()`.
    fn device_init_writes(&self) -> &'static [&'static [u8]] {
        crate::config::i2c_device::device_init_writes(&self.config.device)
    }

    /// The register actually streamed, with the hold-master → no-hold safety
    /// override. Thin wrapper over the shared
    /// [`crate::config::i2c_device::effective_register`] (see there for why a stale
    /// hold-master 0xE3/0xE5 must be remapped before it can hang the AVR bus).
    fn effective_register(&self) -> u8 {
        crate::config::i2c_device::effective_register(
            &self.config.device,
            self.config.address,
            self.config.register,
        )
    }

    /// Send a one-shot I2C read: write register address, then read N bytes.
    fn request_read(&self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // Write the register address first (sets the device's internal pointer).
        // Use the no-hold-safe register so a stale hold-master SHT2x value can't
        // hang the bus (see `effective_register`).
        let register = self.effective_register();
        if register != 0 {
            ctx.i2c().i2c_write(i32::from(self.config.address), &[register])?;
        }
        // Request a read
        ctx.i2c()
            .i2c_read(i32::from(self.config.address), i32::from(self.config.read_length))?;
        Ok(())
    }
}

/// Decode raw I2C reply bytes into a `ComponentValue` per the output format.
/// A pure function (no `self`) so the big-endian unsigned/signed folding is
/// unit-testable in isolation — the decode the runtime applies live, mirrored
/// as C++ by `codegen/input/i2c_device.rs`.
fn convert_bytes(output: OutputFormat, data: &[u8]) -> ComponentValue {
    match output {
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
        vec![ListenerWiring::I2cAddress {
            address: self.config.address,
            register: self.effective_register(),
        }]
    }

    /// Board-wide reconcile votes for this device — all reconciled centrally by
    /// the runtime ([`reconcile::plan_board`](crate::runtime::reconcile::plan_board)),
    /// never applied per-node (per-node let the last-initialized I2C node win and
    /// zero another's required setting):
    /// - **`sampling_interval_ms`** — this device's stream rate. Reconciled to the
    ///   MAX across nodes (the board's single global interval), so a fast node
    ///   can't out-pace a slower sensor's conversion and read stale/zero data.
    /// - **`i2c_read_delay_us`** — no-hold SHT2x/HTU21 NACK until the conversion
    ///   completes, so the board must pause between the register write and the
    ///   read. At 11-bit (`device_init_writes` → user reg 0x83) the worst case is
    ///   RH 15ms / T 11ms, so 16ms covers both. Firmata's `I2C_CONFIG` delay is two
    ///   **7-bit** sysex bytes → it caps at 16383 µs (≈16.4ms); 16000 sits just
    ///   under. (The 11/11-bit pair is the only one whose *both* conversions fit
    ///   the cap.) Other devices read immediately. Reconciled to the MAX.
    /// - **`i2c_continuous_read`** — the read this node streams (via the
    ///   no-hold-safe `effective_register` so a stale hold-master `SHT2x` register
    ///   can't reach the bus). `None` when `autoread` is off: the node then reads
    ///   only on demand via the `trigger` handle (`dispatch` → `request_read`), so
    ///   nothing is armed and the bus stays quiet until triggered.
    fn board_wiring(&self) -> BoardWiring {
        BoardWiring {
            sampling_interval_ms: Some(self.config.sample_interval_ms),
            i2c_read_delay_us: crate::config::i2c_device::is_no_hold_sht2x(&self.config.device)
                .then_some(16_000),
            i2c_continuous_read: self.config.autoread.then(|| I2cContinuousRead {
                address: self.config.address,
                register: self.effective_register(),
                length: self.config.read_length,
            }),
        }
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
                ctx.i2c().i2c_write(i32::from(self.config.address), &data)?;
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
            ctx.i2c().i2c_write(i32::from(self.config.address), payload)?;
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

    fn on_i2c_reply(&mut self, bytes: &[u8], _ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // The runtime unmarshals the I2C-reply Hardware Callback to raw bytes
        // once at the dispatch site (`ComponentValue::as_byte_vec`), so decode
        // straight from the slice — no per-node re-unwrap.
        let converted = convert_bytes(self.config.output, bytes);
        // `set_value` already emits "value" on change; a second explicit emit
        // would re-fire on every poll (even when unchanged) now that the emit
        // layer no longer value-dedupes.
        self.base.set_value(converted);
        // No re-request here: the board streams these replies on its own
        // (continuous read armed in `initialize`), so each reply is a value update.
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

    // Device-preset knowledge (normalisation, the full init-writes table, the
    // hold-master remap) is unit-tested authoritatively in `crate::config::i2c_device`.
    // The tests here cover the *runtime* wiring: that the wrappers thread the
    // config through, and the runtime-specific read-delay / autoread behaviour.

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
    fn advanced_devices_init_through_the_wrapper() {
        // Spot-check the wrapper threads the config `device` into the shared table:
        // the newly-supported sensors must each arm their power-on/config write.
        assert_eq!(device("mpu6050_accel").device_init_writes(), &[&[0x6Bu8, 0x00][..]]);
        assert_eq!(device("mpu6050_gyro").device_init_writes(), &[&[0x6Bu8, 0x00][..]]);
        assert_eq!(device("bmp280_pressure").device_init_writes().len(), 2);
        assert!(device("vl53l0x").device_init_writes().is_empty(), "vl53l0x stays uninitialised");
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
            let delay = dev.board_wiring().i2c_read_delay_us;
            assert_eq!(delay, Some(16_000), "device {id} needs a read-delay");
            // Must stay within Firmata's 7-bit I2C_CONFIG cap (16383 µs).
            assert!(delay.unwrap() <= 16_383, "delay exceeds the sysex cap");
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
            assert_eq!(
                device(id).board_wiring().i2c_read_delay_us,
                None,
                "device {id} must not delay reads"
            );
        }
    }

    #[test]
    fn autoread_defaults_on_and_arms_a_continuous_read() {
        // Default (and flows saved before `autoread` existed, via serde default)
        // stream: a continuous read is armed for the central runtime to fire.
        let dev = device("custom");
        assert!(dev.config.autoread, "autoread must default to on");
        let read = dev
            .board_wiring()
            .i2c_continuous_read
            .expect("autoread on must arm a continuous read");
        assert_eq!(read.address, dev.config.address);
        assert_eq!(read.length, dev.config.read_length);
    }

    #[test]
    fn autoread_off_arms_no_continuous_read() {
        // With autoread off the node is trigger-only: nothing is armed, so the
        // runtime's central stop-all-then-start-all leaves this address quiet.
        let config = I2cDeviceConfig { autoread: false, ..Default::default() };
        let dev = I2cDevice::new("d-1".to_string(), config);
        assert!(
            dev.board_wiring().i2c_continuous_read.is_none(),
            "autoread off must not stream"
        );
    }

    #[test]
    fn autoread_absent_key_defaults_to_streaming() {
        // A pre-`autoread` doc omits the key entirely; serde's default must keep
        // it streaming so existing flows don't silently go quiet after upgrade.
        let cfg: I2cDeviceConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(cfg.autoread);
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
        assert_eq!(cfg.sample_interval_ms, 50);
    }

    // --- convert_bytes: the numeric decode, now a pure fn tested in isolation ---

    #[test]
    fn convert_bytes_raw_preserves_every_byte() {
        assert_eq!(
            convert_bytes(OutputFormat::Raw, &[0x01, 0xFF, 0x00]),
            ComponentValue::Array(vec![
                ComponentValue::Number(1.0),
                ComponentValue::Number(255.0),
                ComponentValue::Number(0.0),
            ]),
        );
    }

    #[test]
    fn convert_bytes_unsigned_is_big_endian() {
        // 0x0102 = 258 across two bytes, MSB first.
        assert_eq!(
            convert_bytes(OutputFormat::UnsignedInt, &[0x01, 0x02]),
            ComponentValue::Number(258.0),
        );
        // High bit set stays positive when unsigned.
        assert_eq!(
            convert_bytes(OutputFormat::UnsignedInt, &[0xFF, 0xFF]),
            ComponentValue::Number(65535.0),
        );
    }

    #[test]
    fn convert_bytes_signed_sign_extends_from_msb() {
        // 0xFFFF as signed 16-bit is -1; the fold sign-extends from the MSB.
        assert_eq!(convert_bytes(OutputFormat::SignedInt, &[0xFF, 0xFF]), ComponentValue::Number(-1.0));
        // A clear high byte stays positive.
        assert_eq!(convert_bytes(OutputFormat::SignedInt, &[0x00, 0x2A]), ComponentValue::Number(42.0));
    }

    #[test]
    fn convert_bytes_signed_empty_is_zero() {
        assert_eq!(convert_bytes(OutputFormat::SignedInt, &[]), ComponentValue::Number(0.0));
    }

    #[test]
    fn convert_bytes_folds_at_most_four_bytes() {
        // Only the first 4 bytes fold in; trailing bytes are ignored (u32 cap).
        assert_eq!(
            convert_bytes(OutputFormat::UnsignedInt, &[0x01, 0x02, 0x03, 0x04, 0x05]),
            ComponentValue::Number(f64::from(0x0102_0304_u32)),
        );
    }
}
