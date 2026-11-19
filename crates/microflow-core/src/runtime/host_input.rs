//! Host input fan-out — a key or a MIDI message a **Runtime Host** read off a
//! device, delivered to every node of the flow that listens for it.
//!
//! The split is the one pins and I2C already have. The host owns the device
//! I/O: it registers the keyboard shortcuts, opens the Web MIDI / `midir`
//! ports, and hands over each raw input as it arrives. Which nodes hear that
//! input is decided here, once, for both hosts:
//!
//! - [`FlowRuntime::dispatch_key_event`] — an accelerator, pressed or released.
//! - [`FlowRuntime::dispatch_midi_message`] — a raw message and the name of the
//!   port it arrived on.
//!
//! What a host must have open is the flow's desired state, and core reports it
//! as answers rather than as filters for the host to interpret:
//! [`FlowRuntime::listens_to_midi`] (is there any MIDI interest at all — a
//! browser must not ask for Web MIDI access otherwise) and
//! [`FlowRuntime::wants_midi_input`] (should this port be open).
//! [`midi_device_matches`] is the one device-name rule behind both, and the
//! rule a host applies to its output ports for a
//! [`CloudRequestKind::MidiSend`](super::CloudRequestKind::MidiSend).
//!
//! **Order.** Listeners hear an input one at a time, in node-id order, and each
//! listener's cascade settles before the next one hears it. All of it is one
//! turn with one [`Effects`], but the listeners do not pay for each other:
//! each cascade has the whole turn budget, so one that runs away is stopped
//! (and badged) on its own and the listeners after it still hear the input;
//! and a timer one cascade arms and a later one cancels is not left armed.

use super::{ComponentValue, Effects, FlowRuntime, ScheduleRequests};
use std::sync::Arc;

/// Does the host MIDI port `port_name` pass the device filter `filter`?
///
/// The filter is a case-insensitive substring of the port name, and the empty
/// filter passes every port. Nothing is trimmed: whitespace in the filter has
/// to be in the name.
#[must_use]
pub fn midi_device_matches(port_name: &str, filter: &str) -> bool {
    folded_matches(&fold_device_name(port_name), &fold_device_name(filter))
}

/// The case folding [`midi_device_matches`] compares under. The runtime folds a
/// listener's filter once per flow update and a port name once per message.
pub(super) fn fold_device_name(name: &str) -> String {
    name.to_lowercase()
}

/// [`midi_device_matches`] over a port name and a filter that are both folded.
fn folded_matches(port: &str, filter: &str) -> bool {
    filter.is_empty() || port.contains(filter)
}

impl FlowRuntime {
    /// Deliver a hotkey press (`pressed = true`) or release (`pressed = false`)
    /// to every node listening on `accelerator` (matched case-insensitively).
    pub fn dispatch_key_event(&mut self, accelerator: &str, pressed: bool) -> Effects {
        let listeners = self
            .key_listeners
            .get(&accelerator.to_lowercase())
            .cloned()
            .unwrap_or_default();
        self.fan_out("key", listeners, |rt, id, out, reqs| {
            rt.dispatch_to(id, "key_event", ComponentValue::Bool(pressed), out, reqs);
        })
    }

    /// Deliver one raw MIDI message (`bytes` = `[status, data1, data2]`) that
    /// arrived on the host port `port_name` to every `Midi` in-node whose
    /// device filter the port passes. Several nodes listening to one device all
    /// hear it; a port no node listens to is a no-op turn. Parsing and the
    /// channel/mode filtering are the node's
    /// ([`receive_raw_message`](super::Component::receive_raw_message)).
    pub fn dispatch_midi_message(&mut self, port_name: &str, bytes: &[u8]) -> Effects {
        let port = fold_device_name(port_name);
        let listeners: Vec<Arc<str>> = self
            .midi_listeners
            .iter()
            .filter(|(_, filter)| folded_matches(&port, filter))
            .map(|(id, _)| Arc::clone(id))
            .collect();
        self.fan_out("midi", listeners, |rt, id, _, _| {
            if let Some(component) = rt.components.get_mut(id) {
                component.receive_raw_message(port_name, bytes);
            }
        })
    }

    /// Whether any node of the flow listens to MIDI input. A host with nothing
    /// to listen for opens no port and asks for no device access.
    #[must_use]
    pub fn listens_to_midi(&self) -> bool {
        !self.midi_listeners.is_empty()
    }

    /// Whether the host should have the MIDI input port `port_name` open: some
    /// `Midi` in-node's device filter passes it.
    #[must_use]
    pub fn wants_midi_input(&self, port_name: &str) -> bool {
        let port = fold_device_name(port_name);
        self.midi_listeners.iter().any(|(_, filter)| folded_matches(&port, filter))
    }

    /// One host input as one turn: `deliver` it to each of `listeners` in
    /// order, draining the cascade it starts before the next listener hears it.
    fn fan_out(
        &mut self,
        stimulus: &'static str,
        listeners: Vec<Arc<str>>,
        mut deliver: impl FnMut(&mut Self, &str, &mut Vec<u8>, &mut ScheduleRequests),
    ) -> Effects {
        let mut waiting = listeners.into_iter();
        self.finish_fed(stimulus, Vec::new(), ScheduleRequests::default(), |rt, out, reqs| {
            let Some(id) = waiting.next() else { return false };
            deliver(rt, &id, out, reqs);
            true
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
    use crate::runtime::tests::{armed_after, TestTimer};
    use crate::runtime::{ComponentBase, TURN_BUDGET};
    use serde_json::json;

    fn node(id: &str, instance: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(instance.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
        FlowEdge {
            id: None,
            source: source.to_string(),
            source_handle: source_handle.to_string(),
            target: target.to_string(),
            target_handle: target_handle.to_string(),
        }
    }

    fn runtime(nodes: Vec<FlowNode>, edges: Vec<FlowEdge>) -> FlowRuntime {
        let mut rt = FlowRuntime::new();
        rt.update_flow(FlowUpdate { nodes, edges });
        rt
    }

    /// `(source, handle)` of every UI-visible event of a turn, in order.
    fn emitted(effects: &Effects) -> Vec<(&str, &str)> {
        effects
            .component_events
            .iter()
            .map(|e| (e.source.as_ref(), e.source_handle.as_ref()))
            .collect()
    }

    /// The nodes that emitted in a turn, in order, without repeats.
    fn emitters(effects: &Effects) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for event in &effects.component_events {
            if out.last() != Some(&event.source.as_ref()) {
                out.push(event.source.as_ref());
            }
        }
        out
    }

    // --- The device-name rule ------------------------------------------------

    #[test]
    fn an_empty_filter_passes_every_port() {
        assert!(midi_device_matches("Launchpad Mini MK3", ""));
        assert!(midi_device_matches("", ""));
    }

    #[test]
    fn a_filter_is_a_case_insensitive_substring_of_the_port_name() {
        assert!(midi_device_matches("Launchpad Mini MK3", "launchpad"));
        assert!(midi_device_matches("Launchpad Mini MK3", "LAUNCHPAD"));
        assert!(midi_device_matches("launchpad mini mk3", "Mini MK"));
        assert!(midi_device_matches("ÉCLAT Synth", "éclat"));
        assert!(!midi_device_matches("Launchpad Mini MK3", "push"));
        // The filter must be inside the name, not the other way round.
        assert!(!midi_device_matches("Launchpad", "Launchpad Mini"));
        // A port with no name passes only the empty filter.
        assert!(!midi_device_matches("", "launchpad"));
    }

    #[test]
    fn whitespace_in_a_filter_is_not_trimmed_or_collapsed() {
        assert!(midi_device_matches("Launchpad Mini MK3", "pad mini"));
        assert!(!midi_device_matches("Launchpad Mini MK3", " launchpad"));
        assert!(!midi_device_matches("Launchpad Mini MK3", "launchpad  mini"));
    }

    // --- Keys ------------------------------------------------------------------

    #[test]
    fn a_key_reaches_every_node_listening_on_it_pressed_and_released() {
        let mut rt = runtime(
            vec![
                node("hk-a", "Hotkey", json!({ "accelerator": "x" })),
                node("hk-b", "Hotkey", json!({ "accelerator": "x" })),
                node("hk-other", "Hotkey", json!({ "accelerator": "y" })),
            ],
            Vec::new(),
        );

        let pressed = rt.dispatch_key_event("x", true);
        assert_eq!(
            emitted(&pressed),
            vec![
                ("hk-a", "value"),
                ("hk-a", "event"),
                ("hk-a", "true"),
                ("hk-b", "value"),
                ("hk-b", "event"),
                ("hk-b", "true"),
            ],
        );
        assert!(pressed.component_events.iter().all(|e| e.value == ComponentValue::Bool(true)));

        let released = rt.dispatch_key_event("x", false);
        assert_eq!(
            emitted(&released),
            vec![
                ("hk-a", "value"),
                ("hk-a", "event"),
                ("hk-a", "false"),
                ("hk-b", "value"),
                ("hk-b", "event"),
                ("hk-b", "false"),
            ],
        );
        assert!(released.component_events.iter().all(|e| e.value == ComponentValue::Bool(false)));
    }

    #[test]
    fn an_accelerator_matches_whatever_its_case() {
        let mut rt = runtime(vec![node("hk", "Hotkey", json!({ "accelerator": "Mod+K" }))], Vec::new());

        assert_eq!(emitters(&rt.dispatch_key_event("mod+k", true)), vec!["hk"]);
        assert_eq!(emitters(&rt.dispatch_key_event("MOD+K", false)), vec!["hk"]);
    }

    #[test]
    fn a_key_no_node_listens_on_is_a_no_op_turn() {
        let mut rt = runtime(vec![node("hk", "Hotkey", json!({ "accelerator": "x" }))], Vec::new());

        assert!(rt.dispatch_key_event("y", true).is_empty());
    }

    #[test]
    fn key_listeners_hear_a_key_in_node_id_order() {
        // Eight listeners: an order that only held by accident of the component
        // map's iteration would not survive this.
        let ids = ["hk-8", "hk-3", "hk-6", "hk-1", "hk-7", "hk-2", "hk-5", "hk-4"];
        let mut rt = runtime(
            ids.iter().map(|id| node(id, "Hotkey", json!({ "accelerator": "x" }))).collect(),
            Vec::new(),
        );

        assert_eq!(
            emitters(&rt.dispatch_key_event("x", true)),
            vec!["hk-1", "hk-2", "hk-3", "hk-4", "hk-5", "hk-6", "hk-7", "hk-8"],
        );
    }

    #[test]
    fn a_listeners_cascade_settles_before_the_next_listener_hears_the_key() {
        // hk-a drives a gate. Delivered listener by listener, the gate reacts
        // before hk-b hears the key; delivered to both before draining, hk-b
        // would emit ahead of the gate.
        let mut rt = runtime(
            vec![
                node("hk-a", "Hotkey", json!({ "accelerator": "x" })),
                node("hk-b", "Hotkey", json!({ "accelerator": "x" })),
                node("gate", "Gate", json!({ "gate": "or" })),
            ],
            vec![edge("hk-a", "true", "gate", "value")],
        );

        let effects = rt.dispatch_key_event("x", true);

        assert_eq!(emitters(&effects), vec!["hk-a", "gate", "hk-b"]);
    }

    #[test]
    fn a_removed_hotkey_stops_hearing_its_key() {
        let mut rt = runtime(vec![node("hk", "Hotkey", json!({ "accelerator": "x" }))], Vec::new());
        rt.update_flow(FlowUpdate { nodes: Vec::new(), edges: Vec::new() });

        assert!(rt.dispatch_key_event("x", true).is_empty());
    }

    // --- One listener's runaway cascade does not cost another the input ---------

    /// Two Gates feeding each other on `handle` (`"true"` or `"false"`): once a
    /// value of that truth reaches `{name}-1` the pair never settles, so the
    /// cascade that reached it spends a whole turn budget.
    fn runaway_ring(name: &str, handle: &str) -> (Vec<FlowNode>, Vec<FlowEdge>) {
        let (one, two) = (format!("{name}-1"), format!("{name}-2"));
        (
            vec![node(&one, "Gate", json!({ "gate": "or" })), node(&two, "Gate", json!({ "gate": "or" }))],
            vec![edge(&one, handle, &two, "value"), edge(&two, handle, &one, "value")],
        )
    }

    /// The nodes a turn paused as a runaway loop, sorted.
    fn paused_in(effects: &Effects) -> Vec<&str> {
        let mut paused: Vec<&str> = effects
            .node_diagnostics
            .iter()
            .filter(|d| d.message.as_deref().is_some_and(|m| m.contains("loop")))
            .map(|d| d.node.as_str())
            .collect();
        paused.sort_unstable();
        paused
    }

    fn heard(effects: &Effects, node: &str, handle: &str) -> bool {
        emitted(effects).contains(&(node, handle))
    }

    #[test]
    fn a_listener_whose_cascade_runs_away_does_not_cost_the_next_one_the_key() {
        // hk-a's press spins one ring and its release another; hk-b is wired to
        // nothing. Each of hk-a's cascades spends a whole budget, and hk-b
        // still hears the press and the release.
        let (mut nodes, mut edges) = runaway_ring("on", "true");
        let (off_nodes, off_edges) = runaway_ring("off", "false");
        nodes.extend(off_nodes);
        edges.extend(off_edges);
        nodes.extend([
            node("hk-a", "Hotkey", json!({ "accelerator": "x" })),
            node("hk-b", "Hotkey", json!({ "accelerator": "x" })),
        ]);
        edges.extend([edge("hk-a", "true", "on-1", "value"), edge("hk-a", "false", "off-1", "value")]);
        let mut rt = runtime(nodes, edges);

        let pressed = rt.dispatch_key_event("x", true);
        assert_eq!(paused_in(&pressed), vec!["on-1", "on-2"], "hk-a's press ran away");
        assert!(pressed.component_events.len() > TURN_BUDGET as usize);
        assert!(heard(&pressed, "hk-b", "true"), "hk-b must still hear the press");

        let released = rt.dispatch_key_event("x", false);
        assert_eq!(paused_in(&released), vec!["off-1", "off-2"], "hk-a's release ran away");
        assert!(heard(&released, "hk-b", "false"), "hk-b must still hear the release");
    }

    #[test]
    fn every_listener_cascade_gets_the_whole_budget() {
        // Both listeners spin their own ring: each ring is found and paused,
        // which takes each cascade running to the budget on its own.
        let (mut nodes, mut edges) = runaway_ring("a", "true");
        let (b_nodes, b_edges) = runaway_ring("b", "true");
        nodes.extend(b_nodes);
        edges.extend(b_edges);
        nodes.extend([
            node("hk-a", "Hotkey", json!({ "accelerator": "x" })),
            node("hk-b", "Hotkey", json!({ "accelerator": "x" })),
        ]);
        edges.extend([edge("hk-a", "true", "a-1", "value"), edge("hk-b", "true", "b-1", "value")]);
        let mut rt = runtime(nodes, edges);

        let pressed = rt.dispatch_key_event("x", true);

        assert_eq!(paused_in(&pressed), vec!["a-1", "a-2", "b-1", "b-2"]);
        assert_eq!(pressed.component_events.len(), 2 * TURN_BUDGET as usize);
    }

    // --- Timers asked for by one listener's cascade and another's -----------------

    /// Two hotkeys on `x` and a timer `d`: hk-a's press drives `d.{first}`,
    /// hk-b's drives `d.{second}`.
    fn timer_flow(first: &str, second: &str) -> FlowRuntime {
        let mut rt = FlowRuntime::new();
        rt.register_test_factory(
            "TestTimer",
            Box::new(|id, _| {
                Ok(Box::new(TestTimer { base: ComponentBase::new(id, ComponentValue::default()) }))
            }),
        );
        rt.update_flow(FlowUpdate {
            nodes: vec![
                node("hk-a", "Hotkey", json!({ "accelerator": "x" })),
                node("hk-b", "Hotkey", json!({ "accelerator": "x" })),
                node("d", "TestTimer", json!({})),
            ],
            edges: vec![edge("hk-a", "true", "d", first), edge("hk-b", "true", "d", second)],
        });
        rt
    }

    #[test]
    fn a_timer_one_listener_arms_and_the_next_cancels_is_not_left_armed() {
        let mut rt = timer_flow("arm", "disarm");

        let pressed = rt.dispatch_key_event("x", true);

        assert!(armed_after(&[&pressed]).is_empty(), "{pressed:?}");
        // The runtime agrees with the host: there is nothing left to cancel.
        let disarmed = rt.dispatch("d", "disarm", ComponentValue::default());
        assert!(disarmed.cancellations.is_empty(), "{disarmed:?}");
    }

    #[test]
    fn a_timer_one_listener_cancels_and_the_next_arms_is_left_armed_once() {
        let mut rt = timer_flow("disarm", "arm");
        let before = rt.dispatch("d", "arm", ComponentValue::default());
        assert_eq!(before.wakeups.len(), 1);

        let pressed = rt.dispatch_key_event("x", true);

        let armed = armed_after(&[&before, &pressed]);
        assert_eq!(armed.len(), 1, "{pressed:?}");
        assert_ne!(armed[0].id, before.wakeups[0].id, "the earlier timer is the one cancelled");
        // The runtime agrees with the host about which timer is left.
        let disarmed = rt.dispatch("d", "disarm", ComponentValue::default());
        assert_eq!(disarmed.cancellations, vec![armed[0].id]);
    }

    #[test]
    fn a_timer_two_listeners_arm_is_left_armed_once() {
        let mut rt = timer_flow("arm", "arm");

        let pressed = rt.dispatch_key_event("x", true);

        let armed = armed_after(&[&pressed]);
        assert_eq!(armed.len(), 1, "{pressed:?}");
        let disarmed = rt.dispatch("d", "disarm", ComponentValue::default());
        assert_eq!(disarmed.cancellations, vec![armed[0].id]);
    }

    // --- MIDI ------------------------------------------------------------------

    #[cfg(feature = "cloud")]
    mod midi {
        use super::*;

        const NOTE_ON: [u8; 3] = [0x90, 60, 100];

        fn midi_in(id: &str, device_name: &str) -> FlowNode {
            node(id, "Midi", json!({ "direction": "in", "deviceName": device_name }))
        }

        #[test]
        fn a_message_reaches_every_in_node_whose_filter_the_port_passes() {
            let mut rt = runtime(
                vec![
                    midi_in("m-pad", "launchpad"),
                    midi_in("m-all", ""),
                    midi_in("m-keys", "keystation"),
                ],
                Vec::new(),
            );

            let effects = rt.dispatch_midi_message("Launchpad Mini", &NOTE_ON);

            assert_eq!(
                emitted(&effects),
                vec![
                    ("m-all", "note"),
                    ("m-all", "velocity"),
                    ("m-all", "on"),
                    ("m-pad", "note"),
                    ("m-pad", "velocity"),
                    ("m-pad", "on"),
                ],
            );
        }

        #[test]
        fn a_port_no_filter_passes_is_a_no_op_turn() {
            let mut rt = runtime(vec![midi_in("m-pad", "launchpad")], Vec::new());

            assert!(rt.dispatch_midi_message("Keystation 49", &NOTE_ON).is_empty());
        }

        #[test]
        fn in_nodes_hear_a_message_in_node_id_order() {
            let ids = ["m-8", "m-3", "m-6", "m-1", "m-7", "m-2", "m-5", "m-4"];
            let mut rt = runtime(ids.iter().map(|id| midi_in(id, "")).collect(), Vec::new());

            assert_eq!(
                emitters(&rt.dispatch_midi_message("Launchpad Mini", &NOTE_ON)),
                vec!["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7", "m-8"],
            );
        }

        #[test]
        fn a_listeners_cascade_settles_before_the_next_listener_hears_the_message() {
            let mut rt = runtime(
                vec![
                    midi_in("m-a", ""),
                    midi_in("m-b", ""),
                    node("gate", "Gate", json!({ "gate": "or" })),
                ],
                vec![edge("m-a", "on", "gate", "value")],
            );

            let effects = rt.dispatch_midi_message("Launchpad Mini", &NOTE_ON);

            assert_eq!(emitters(&effects), vec!["m-a", "gate", "m-b"]);
        }

        #[test]
        fn the_node_still_filters_what_it_hears() {
            // The fan-out picks the listeners by port; channel and mode are the
            // node's own filter on what a listener then does with the bytes.
            let mut rt = runtime(
                vec![
                    node("m-ch2", "Midi", json!({ "direction": "in", "channel": 2 })),
                    node("m-cc", "Midi", json!({ "direction": "in", "mode": "cc", "control": 7 })),
                ],
                Vec::new(),
            );

            assert!(rt.dispatch_midi_message("Launchpad Mini", &NOTE_ON).is_empty());
            assert_eq!(
                emitted(&rt.dispatch_midi_message("Launchpad Mini", &[0xB0, 7, 99])),
                vec![("m-cc", "value")],
            );
        }

        #[test]
        fn an_out_node_is_not_a_listener() {
            let mut rt = runtime(
                vec![node("m-out", "Midi", json!({ "direction": "out", "deviceName": "" }))],
                Vec::new(),
            );

            assert!(!rt.listens_to_midi());
            assert!(!rt.wants_midi_input("Launchpad Mini"));
            assert!(rt.dispatch_midi_message("Launchpad Mini", &NOTE_ON).is_empty());
        }

        #[test]
        fn the_wanted_inputs_are_the_ports_some_in_node_listens_to() {
            let mut rt = FlowRuntime::new();
            assert!(!rt.listens_to_midi(), "an empty flow listens to nothing");
            assert!(!rt.wants_midi_input("Launchpad Mini"));

            rt.update_flow(FlowUpdate {
                nodes: vec![midi_in("m-pad", "LaunchPad"), midi_in("m-keys", "keystation")],
                edges: Vec::new(),
            });
            assert!(rt.listens_to_midi());
            assert!(rt.wants_midi_input("Launchpad Mini"));
            assert!(rt.wants_midi_input("KEYSTATION 49"));
            assert!(!rt.wants_midi_input("Drum Machine"));

            // One listener for every device wants every port.
            rt.update_flow(FlowUpdate { nodes: vec![midi_in("m-all", "")], edges: Vec::new() });
            assert!(rt.wants_midi_input("Drum Machine"));

            // The desired state follows the flow.
            rt.update_flow(FlowUpdate { nodes: Vec::new(), edges: Vec::new() });
            assert!(!rt.listens_to_midi());
            assert!(!rt.wants_midi_input("Launchpad Mini"));
        }

        #[test]
        fn an_in_node_whose_cascade_runs_away_does_not_cost_the_next_one_the_message() {
            let (mut nodes, mut edges) = runaway_ring("ring", "true");
            nodes.extend([midi_in("m-a", ""), midi_in("m-b", "")]);
            edges.push(edge("m-a", "on", "ring-1", "value"));
            let mut rt = runtime(nodes, edges);

            let effects = rt.dispatch_midi_message("Launchpad Mini", &NOTE_ON);

            assert_eq!(paused_in(&effects), vec!["ring-1", "ring-2"], "m-a's cascade ran away");
            assert!(effects.component_events.len() > TURN_BUDGET as usize);
            assert!(heard(&effects, "m-b", "on"), "m-b must still hear the message");
        }

        #[test]
        fn a_port_passes_a_filter_whatever_the_case_of_either() {
            let mut rt = runtime(vec![midi_in("m-pad", "LaunchPad")], Vec::new());

            assert_eq!(
                emitters(&rt.dispatch_midi_message("LAUNCHPAD MINI", &NOTE_ON)),
                vec!["m-pad"],
            );
        }
    }
}
