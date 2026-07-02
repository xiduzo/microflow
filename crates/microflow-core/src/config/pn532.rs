//! PN532 NFC reader config — shared single source (ungated) for the live runtime
//! and any future codegen emitter, like every other node config in `crate::config`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
// The web sends camelCase keys (`pollIntervalMs`); without this the multi-word
// field silently falls back to its default. Matches the I2C device config.
#[serde(rename_all = "camelCase")]
pub struct Pn532Config {
    /// 7-bit I2C address. The Aideepen V3 module answers on `0x24` when its DIP
    /// switches select I2C (not SPI/HSU).
    #[serde(default = "default_address")]
    pub address: u8,
    /// How often (ms) a fresh `InListPassiveTarget` is issued while sensing for a
    /// card. Effectively floored by the board's global sampling interval when the
    /// PN532 shares a bus with streaming sensors.
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u32,
}

fn default_address() -> u8 {
    0x24
}
fn default_poll_interval_ms() -> u32 {
    300
}

impl Default for Pn532Config {
    fn default() -> Self {
        Self { address: default_address(), poll_interval_ms: default_poll_interval_ms() }
    }
}
