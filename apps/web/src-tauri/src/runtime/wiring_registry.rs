//! Per-component wiring registry.
//!
//! Owns the runtime-side bookkeeping behind a [`ListenerWiring`] enum:
//! `(pin, listener)` map, `(key, component-id)` map, `(i2c-address,
//! component-id)` map, plus a back-index `component-id -> Vec<ListenerWiring>`
//! used to revoke a single component's wiring without wiping the table.
//!
//! Before [`WiringRegistry`], `FlowRuntime::update_flow` cleared all three
//! tables and re-registered every component on every update — which then
//! forced a global `reset_all_reporting()` on the Firmata wire (29 wire ops)
//! even for a one-node tweak. This module replaces that pattern with
//! `install` + `revoke` so flow updates touch only the pins that actually
//! changed. See `CONTEXT.md` § Wiring.

use super::wiring::ListenerWiring;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Pin listener registration for immediate event routing.
///
/// The pin callback in `FlowRuntime::install_pin_change_callback` consults
/// the pin_listeners map (held inside the registry) and dispatches one of
/// these per pin change.
#[derive(Clone)]
pub struct PinListener {
    pub component_id: Arc<str>,
    pub pin: u8,
    pub is_analog: bool,
    pub threshold: u16,
}

/// What changed in Firmata-reporting terms after one or more `install` /
/// `revoke` operations.
///
/// `is_analog` is the second element of each tuple: `true` for analog
/// reporting, `false` for digital. The Firmata wire-level enable/disable
/// commands differ between the two.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct WiringDelta {
    /// Pins that newly need Firmata reporting enabled.
    pub pins_to_enable: Vec<(u8, bool)>,
    /// Pins no longer used by any component, safe to disable.
    pub pins_to_disable: Vec<(u8, bool)>,
}

impl WiringDelta {
    #[must_use]
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.pins_to_enable.is_empty() && self.pins_to_disable.is_empty()
    }
}

/// Bookkeeping for every `ListenerWiring` returned by an active component.
pub struct WiringRegistry {
    by_component: Mutex<HashMap<Arc<str>, Vec<ListenerWiring>>>,
    pin_listeners: Arc<Mutex<HashMap<u8, Vec<PinListener>>>>,
    key_listeners: Arc<Mutex<HashMap<String, Vec<Arc<str>>>>>,
    i2c_listeners: Arc<Mutex<HashMap<u8, Vec<Arc<str>>>>>,
}

impl WiringRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            by_component: Mutex::new(HashMap::new()),
            pin_listeners: Arc::new(Mutex::new(HashMap::new())),
            key_listeners: Arc::new(Mutex::new(HashMap::new())),
            i2c_listeners: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Shared handle to the pin listeners map (used by the pin-change callback
    /// closure to dispatch raw board events to the right components).
    #[must_use]
    pub fn pin_listeners(&self) -> Arc<Mutex<HashMap<u8, Vec<PinListener>>>> {
        Arc::clone(&self.pin_listeners)
    }

    /// Shared handle to the key listeners map (used by the hotkey dispatch
    /// path in the Tauri command layer).
    #[must_use]
    pub fn key_listeners(&self) -> Arc<Mutex<HashMap<String, Vec<Arc<str>>>>> {
        Arc::clone(&self.key_listeners)
    }

    /// Shared handle to the I2C listeners map (used by the I2C reply
    /// callback closure).
    #[must_use]
    pub fn i2c_listeners(&self) -> Arc<Mutex<HashMap<u8, Vec<Arc<str>>>>> {
        Arc::clone(&self.i2c_listeners)
    }

    /// Snapshot the current set of pins that have at least one listener,
    /// along with whether each pin is reported as analog. Used to compute a
    /// [`WiringDelta`] across an update window: snapshot before, apply
    /// `install`/`revoke`, snapshot after.
    #[must_use]
    pub fn pin_use_snapshot(&self) -> HashMap<u8, bool> {
        let listeners = self
            .pin_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        listeners
            .iter()
            .filter_map(|(pin, vec)| {
                vec.first().map(|first| (*pin, first.is_analog))
            })
            .collect()
    }

    /// Install (or replace) a component's wirings. Calling `install` for an
    /// id that already has wirings revokes the previous set first, so it is
    /// safe to call repeatedly without externally tracking presence.
    pub fn install(&self, id: Arc<str>, wirings: Vec<ListenerWiring>) {
        self.revoke(&id);
        if wirings.is_empty() {
            return;
        }
        {
            let mut by_component = self
                .by_component
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            by_component.insert(Arc::clone(&id), wirings.clone());
        }
        for wiring in wirings {
            self.apply_install(&id, wiring);
        }
    }

    /// Remove a component's wirings from every index. Cheap no-op if the
    /// component has nothing registered.
    pub fn revoke(&self, id: &str) {
        let prev = {
            let mut by_component = self
                .by_component
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            by_component.remove(id)
        };
        let Some(wirings) = prev else { return };
        for wiring in wirings {
            self.apply_revoke(id, &wiring);
        }
    }

    /// Drop every wiring from every index. Used during full clear / shutdown.
    #[allow(dead_code)]
    pub fn clear(&self) {
        let mut by_component = self
            .by_component
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        by_component.clear();
        self.pin_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.key_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.i2c_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    /// Compute the pin-reporting delta between two snapshots produced by
    /// [`pin_use_snapshot`](Self::pin_use_snapshot).
    ///
    /// A pin appearing in `post` but not `pre` is queued for `enable`. A pin
    /// appearing in `pre` but not `post` is queued for `disable`. A pin that
    /// flipped analog ↔ digital appears in both lists with the appropriate
    /// `is_analog` flag.
    #[must_use]
    pub fn delta(pre: &HashMap<u8, bool>, post: &HashMap<u8, bool>) -> WiringDelta {
        let mut delta = WiringDelta::default();
        for (&pin, &post_analog) in post {
            match pre.get(&pin) {
                None => delta.pins_to_enable.push((pin, post_analog)),
                Some(&pre_analog) if pre_analog != post_analog => {
                    delta.pins_to_disable.push((pin, pre_analog));
                    delta.pins_to_enable.push((pin, post_analog));
                }
                _ => {}
            }
        }
        for (&pin, &pre_analog) in pre {
            if !post.contains_key(&pin) {
                delta.pins_to_disable.push((pin, pre_analog));
            }
        }
        delta
    }

    fn apply_install(&self, id: &Arc<str>, wiring: ListenerWiring) {
        match wiring {
            ListenerWiring::DigitalPin { pin } => {
                let mut listeners = self
                    .pin_listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                listeners.entry(pin).or_default().push(PinListener {
                    component_id: Arc::clone(id),
                    pin,
                    is_analog: false,
                    threshold: 0,
                });
            }
            ListenerWiring::AnalogPin { pin, threshold } => {
                let mut listeners = self
                    .pin_listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                listeners.entry(pin).or_default().push(PinListener {
                    component_id: Arc::clone(id),
                    pin,
                    is_analog: true,
                    threshold,
                });
            }
            ListenerWiring::I2cAddress { address } => {
                let mut listeners = self
                    .i2c_listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                listeners.entry(address).or_default().push(Arc::clone(id));
            }
            ListenerWiring::HotKey { accelerator } => {
                let mut listeners = self
                    .key_listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                listeners.entry(accelerator).or_default().push(Arc::clone(id));
            }
        }
    }

    fn apply_revoke(&self, id: &str, wiring: &ListenerWiring) {
        match wiring {
            ListenerWiring::DigitalPin { pin } | ListenerWiring::AnalogPin { pin, .. } => {
                let mut listeners = self
                    .pin_listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(vec) = listeners.get_mut(pin) {
                    vec.retain(|l| l.component_id.as_ref() != id);
                    if vec.is_empty() {
                        listeners.remove(pin);
                    }
                }
            }
            ListenerWiring::I2cAddress { address } => {
                let mut listeners = self
                    .i2c_listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(vec) = listeners.get_mut(address) {
                    vec.retain(|c| c.as_ref() != id);
                    if vec.is_empty() {
                        listeners.remove(address);
                    }
                }
            }
            ListenerWiring::HotKey { accelerator } => {
                let mut listeners = self
                    .key_listeners
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(vec) = listeners.get_mut(accelerator) {
                    vec.retain(|c| c.as_ref() != id);
                    if vec.is_empty() {
                        listeners.remove(accelerator);
                    }
                }
            }
        }
    }
}

impl Default for WiringRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arc(s: &str) -> Arc<str> {
        Arc::from(s)
    }

    #[test]
    fn install_then_revoke_clears_pin_index() {
        let reg = WiringRegistry::new();
        reg.install(arc("led-1"), vec![ListenerWiring::DigitalPin { pin: 5 }]);
        assert_eq!(reg.pin_use_snapshot().get(&5), Some(&false));

        reg.revoke("led-1");
        assert!(reg.pin_use_snapshot().is_empty());
    }

    #[test]
    fn install_replaces_previous_wiring_for_id() {
        let reg = WiringRegistry::new();
        reg.install(arc("sensor-1"), vec![ListenerWiring::AnalogPin { pin: 2, threshold: 5 }]);
        reg.install(arc("sensor-1"), vec![ListenerWiring::AnalogPin { pin: 7, threshold: 5 }]);

        let snap = reg.pin_use_snapshot();
        assert!(!snap.contains_key(&2), "old pin should be revoked");
        assert_eq!(snap.get(&7), Some(&true));
    }

    #[test]
    fn delta_disables_removed_enables_new() {
        let reg = WiringRegistry::new();
        reg.install(arc("a"), vec![ListenerWiring::DigitalPin { pin: 3 }]);
        let pre = reg.pin_use_snapshot();

        reg.revoke("a");
        reg.install(arc("b"), vec![ListenerWiring::AnalogPin { pin: 9, threshold: 1 }]);
        let post = reg.pin_use_snapshot();

        let delta = WiringRegistry::delta(&pre, &post);
        assert_eq!(delta.pins_to_disable, vec![(3, false)]);
        assert_eq!(delta.pins_to_enable, vec![(9, true)]);
    }

    #[test]
    fn delta_flags_analog_digital_flip_as_both() {
        let mut pre = HashMap::new();
        pre.insert(4, false);
        let mut post = HashMap::new();
        post.insert(4, true);

        let delta = WiringRegistry::delta(&pre, &post);
        assert!(delta.pins_to_enable.contains(&(4, true)));
        assert!(delta.pins_to_disable.contains(&(4, false)));
    }

    #[test]
    fn unchanged_pin_produces_no_delta() {
        let reg = WiringRegistry::new();
        reg.install(arc("a"), vec![ListenerWiring::DigitalPin { pin: 8 }]);
        let pre = reg.pin_use_snapshot();

        // Same wiring re-installed
        reg.install(arc("a"), vec![ListenerWiring::DigitalPin { pin: 8 }]);
        let post = reg.pin_use_snapshot();

        let delta = WiringRegistry::delta(&pre, &post);
        assert!(delta.is_empty());
    }

    #[test]
    fn shared_pin_kept_alive_when_one_revoked() {
        let reg = WiringRegistry::new();
        reg.install(arc("a"), vec![ListenerWiring::DigitalPin { pin: 4 }]);
        reg.install(arc("b"), vec![ListenerWiring::DigitalPin { pin: 4 }]);

        reg.revoke("a");
        assert_eq!(
            reg.pin_use_snapshot().get(&4),
            Some(&false),
            "pin should remain because b still uses it"
        );
    }

    #[test]
    fn hotkey_install_revoke_round_trip() {
        let reg = WiringRegistry::new();
        reg.install(
            arc("k1"),
            vec![ListenerWiring::HotKey { accelerator: "ctrl+a".into() }],
        );
        {
            let keys = reg.key_listeners();
            let listeners = keys.lock().unwrap();
            assert!(listeners.contains_key("ctrl+a"));
        }
        reg.revoke("k1");
        let keys = reg.key_listeners();
        let listeners = keys.lock().unwrap();
        assert!(!listeners.contains_key("ctrl+a"));
    }
}
