//! Desktop MIDI I/O for the runtime actor — the `midir` twin of the browser's
//! Web MIDI `MidiPerformer`.
//!
//! Owns the open `midir` connections, confined to the actor thread like the
//! runtime itself. Routing stays out of here on purpose: an input callback only
//! forwards the raw bytes as [`ActorMsg::MidiMessage`]; the actor fans each
//! message out against `FlowRuntime::collect_midi_listeners()` (always fresh —
//! no listener state to go stale here). Output connections open lazily on the
//! first send to a matching port name.
//!
//! [`ActorMsg::MidiMessage`]: crate::runtime::host::ActorMsg

use crate::runtime::host::ActorMsg;
use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use microflow_core::runtime::subscriptions::MidiListener;
use std::collections::HashMap;
use tokio::sync::mpsc::UnboundedSender;

/// Client name shown to the OS MIDI stack.
const CLIENT: &str = "microflow";

/// Case-insensitive substring match; an empty filter matches every port.
pub fn device_matches(port_name: &str, filter: &str) -> bool {
    filter.is_empty() || port_name.to_lowercase().contains(&filter.to_lowercase())
}

pub struct MidiManager {
    /// Open input connections keyed by port name. Dropping one closes it.
    inputs: HashMap<String, MidiInputConnection<()>>,
    /// Open output connections keyed by port name, opened lazily per send.
    outputs: HashMap<String, MidiOutputConnection>,
}

impl MidiManager {
    #[must_use]
    pub fn new() -> Self {
        Self { inputs: HashMap::new(), outputs: HashMap::new() }
    }

    /// Reconcile the open input connections against the flow's listeners: open
    /// every port some listener's filter matches, close ports no filter matches
    /// anymore. Called by the actor after every flow update.
    pub fn reconcile(&mut self, listeners: &[MidiListener], tx: &UnboundedSender<ActorMsg>) {
        let wanted = |port_name: &str| {
            listeners.iter().any(|l| device_matches(port_name, &l.device_name))
        };
        self.inputs.retain(|name, _| wanted(name));
        if listeners.is_empty() {
            return;
        }

        let probe = match MidiInput::new(CLIENT) {
            Ok(input) => input,
            Err(e) => {
                log::warn!("[midi] input unavailable: {e}");
                return;
            }
        };
        for port in probe.ports() {
            let Ok(name) = probe.port_name(&port) else { continue };
            if self.inputs.contains_key(&name) || !wanted(&name) {
                continue;
            }
            // One `MidiInput` client per connection — midir consumes it on connect.
            let Ok(input) = MidiInput::new(CLIENT) else { continue };
            let tx = tx.clone();
            let port_name = name.clone();
            match input.connect(
                &port,
                CLIENT,
                move |_ts, message, ()| {
                    let _ = tx.send(ActorMsg::MidiMessage {
                        port_name: port_name.clone(),
                        bytes: message.to_vec(),
                    });
                },
                (),
            ) {
                Ok(conn) => {
                    log::info!("[midi] listening on '{name}'");
                    self.inputs.insert(name, conn);
                }
                Err(e) => log::warn!("[midi] failed to open input '{name}': {e}"),
            }
        }
    }

    /// Write one raw message to every output whose port name matches
    /// `device_name` ("" = all), opening connections lazily.
    pub fn send(&mut self, device_name: &str, bytes: &[u8]) {
        let probe = match MidiOutput::new(CLIENT) {
            Ok(output) => output,
            Err(e) => {
                log::warn!("[midi] output unavailable: {e}");
                return;
            }
        };
        for port in probe.ports() {
            let Ok(name) = probe.port_name(&port) else { continue };
            if !device_matches(&name, device_name) {
                continue;
            }
            if !self.outputs.contains_key(&name) {
                let Ok(output) = MidiOutput::new(CLIENT) else { continue };
                match output.connect(&port, CLIENT) {
                    Ok(conn) => {
                        log::info!("[midi] sending to '{name}'");
                        self.outputs.insert(name.clone(), conn);
                    }
                    Err(e) => {
                        log::warn!("[midi] failed to open output '{name}': {e}");
                        continue;
                    }
                }
            }
            if let Some(conn) = self.outputs.get_mut(&name) {
                if let Err(e) = conn.send(bytes) {
                    log::warn!("[midi] send to '{name}' failed: {e}; dropping connection");
                    self.outputs.remove(&name);
                }
            }
        }
    }
}

impl Default for MidiManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::device_matches;

    #[test]
    fn empty_filter_matches_everything_and_matching_is_case_insensitive() {
        assert!(device_matches("Launchpad Mini MK3", ""));
        assert!(device_matches("Launchpad Mini MK3", "launchpad"));
        assert!(!device_matches("Launchpad Mini MK3", "push"));
    }
}
