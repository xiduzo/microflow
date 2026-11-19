//! Desktop MIDI I/O for the runtime actor — the `midir` twin of the browser's
//! Web MIDI `MidiPerformer`.
//!
//! Owns the open `midir` connections, confined to the actor thread like the
//! runtime itself. It only moves bytes. Which ports are open is the flow's
//! desired state, asked of the runtime on every flow update
//! ([`MidiManager::reconcile`]); an input callback forwards the raw bytes and
//! the port they arrived on as [`ActorMsg::MidiMessage`], and the runtime
//! decides which nodes hear them (`FlowRuntime::dispatch_midi_message`). Output
//! connections open lazily on the first send to a port the runtime's
//! device-name rule matches.
//!
//! [`ActorMsg::MidiMessage`]: crate::runtime::host::ActorMsg

use crate::runtime::host::ActorMsg;
use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use microflow_core::runtime::{midi_device_matches, FlowRuntime};
use std::collections::HashMap;
use tokio::sync::mpsc::UnboundedSender;

/// Client name shown to the OS MIDI stack.
const CLIENT: &str = "microflow";

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

    /// Reconcile the open input connections against the flow `rt` runs: open
    /// every port it wants, close the ports it no longer does. Called by the
    /// actor after every flow update.
    pub fn reconcile(&mut self, rt: &FlowRuntime, tx: &UnboundedSender<ActorMsg>) {
        self.inputs.retain(|name, _| rt.wants_midi_input(name));
        if !rt.listens_to_midi() {
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
            if self.inputs.contains_key(&name) || !rt.wants_midi_input(&name) {
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

    /// Write one raw message to every output port `device_name` addresses
    /// ("" = all), opening connections lazily.
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
            if !midi_device_matches(&name, device_name) {
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
