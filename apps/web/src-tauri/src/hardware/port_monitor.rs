//! Serial port discovery and monitoring
//!
//! Handles port enumeration, deduplication (macOS cu/tty pairs),
//! and filtering of system ports.

use serde::{Deserialize, Serialize};
use serialport::SerialPortType;
use std::collections::HashMap;

/// Patterns indicating system ports to skip
const SKIP_PATTERNS: &[&str] = &[
    // macOS system ports
    "debug-console",
    "bluetooth",
    "wlan",
    "blth",
    // Linux system ports
    "ttys",
    "ttysac",
    "ttyama",
    "ttygs",
];

/// Information about a serial port
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String,
    pub description: Option<String>,
    pub has_firmata: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vid: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u16>,
}

impl SerialPortInfo {
    #[must_use] 
    pub fn is_usb(&self) -> bool {
        self.port_type == "USB"
    }

    #[must_use] 
    pub fn usb_ids(&self) -> Option<(u16, u16)> {
        match (self.vid, self.pid) {
            (Some(vid), Some(pid)) => Some((vid, pid)),
            _ => None,
        }
    }
}

/// Serial port discovery utilities
pub struct PortMonitor;

impl PortMonitor {
    /// Get deduplicated list of available serial ports.
    /// On macOS, deduplicates cu.*/tty.* pairs, preferring cu.* variants.
    pub fn get_ports() -> Result<Vec<SerialPortInfo>, Box<dyn std::error::Error>> {
        let ports = serialport::available_ports()?;
        let mut port_map: HashMap<String, SerialPortInfo> = HashMap::new();

        for port in ports {
            let (port_type, description, vid, pid) = Self::extract_port_info(&port.port_type);
            let port_info = SerialPortInfo {
                port_name: port.port_name.clone(),
                port_type,
                description,
                has_firmata: None,
                vid,
                pid,
            };

            let device_id = Self::canonical_id(&port.port_name);

            let should_insert = match port_map.get(&device_id) {
                Some(existing) => Self::should_prefer(&port.port_name, &existing.port_name),
                None => true,
            };

            if should_insert {
                port_map.insert(device_id, port_info);
            }
        }

        Ok(port_map.into_values().collect())
    }

    /// Extract canonical device identifier from port name.
    /// On macOS, removes /dev/cu. or /dev/tty. prefix to deduplicate device pairs.
    #[must_use] 
    pub fn canonical_id(port_name: &str) -> String {
        port_name
            .strip_prefix("/dev/cu.")
            .or_else(|| port_name.strip_prefix("/dev/tty."))
            .unwrap_or(port_name)
            .to_string()
    }

    /// Check if a port should be skipped for Firmata testing.
    #[must_use] 
    pub fn should_skip_firmata_test(port_name: &str) -> bool {
        let port_lower = port_name.to_lowercase();
        let skip = SKIP_PATTERNS
            .iter()
            .any(|pattern| port_lower.contains(pattern));

        if skip {
            log::debug!("Skipping system port: {port_name}");
        }
        skip
    }

    /// Extract type info from serialport type
    fn extract_port_info(
        port_type: &SerialPortType,
    ) -> (String, Option<String>, Option<u16>, Option<u16>) {
        match port_type {
            SerialPortType::UsbPort(info) => {
                let mut desc =
                    format!("USB Device (VID: {:04X}, PID: {:04X})", info.vid, info.pid);
                if let Some(serial) = &info.serial_number {
                    desc.push_str(&format!(", Serial: {serial}"));
                }
                if let Some(product) = &info.product {
                    desc.push_str(&format!(", Product: {product}"));
                }
                ("USB".to_string(), Some(desc), Some(info.vid), Some(info.pid))
            }
            SerialPortType::PciPort => (
                "PCI".to_string(),
                Some("PCI Serial Port".to_string()),
                None,
                None,
            ),
            SerialPortType::BluetoothPort => (
                "Bluetooth".to_string(),
                Some("Bluetooth Serial Port".to_string()),
                None,
                None,
            ),
            SerialPortType::Unknown => ("Unknown".to_string(), None, None, None),
        }
    }

    /// On macOS, prefer cu.* over tty.* for the same device
    fn should_prefer(new_name: &str, existing_name: &str) -> bool {
        if cfg!(target_os = "macos") {
            !existing_name.starts_with("/dev/cu.") && new_name.starts_with("/dev/cu.")
        } else {
            false
        }
    }
}
