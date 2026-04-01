//! Delay Component - Control

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelayConfig {
    #[serde(default = "default_delay")]
    pub delay: u64,
    #[serde(default, rename = "forgetPrevious")]
    pub forget_previous: bool,
}

fn default_delay() -> u64 { 1000 }

impl Default for DelayConfig {
    fn default() -> Self {
        Self { delay: default_delay(), forget_previous: false }
    }
}

pub struct Delay {
    base: ComponentBase,
    config: DelayConfig,
    /// Cancellation flag shared with the pending delay thread.
    /// Setting this to `true` causes the thread to skip sending its event.
    cancel_flag: Arc<AtomicBool>,
    /// Handle to the most recent delay thread for joining on destroy
    thread_handle: Option<std::thread::JoinHandle<()>>,
}

impl Delay {
    #[must_use] 
    pub fn new(id: String, config: DelayConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            thread_handle: None,
        }
    }

    pub fn signal(&mut self, value: ComponentValue) {
        if self.config.forget_previous {
            // Signal the previous thread (if any) to not fire its event
            self.cancel_flag.store(true, Ordering::Relaxed);
            // Create a fresh flag for the new delay
            self.cancel_flag = Arc::new(AtomicBool::new(false));
        }

        let delay_ms = self.config.delay;
        let sender = self.base.event_sender.clone();
        let source = self.base.id.clone();
        let cancel = Arc::clone(&self.cancel_flag);

        // Store value without emitting change (delay component stores input, emits later)
        self.base.value = value.clone();

        // Use a plain OS thread + sleep so this works regardless of whether
        // a Tokio runtime is present on the calling thread.
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            if cancel.load(Ordering::Relaxed) {
                return; // cancelled by a newer signal (forget_previous)
            }
            if let Some(tx) = sender {
                let _ = tx.send(ComponentEvent {
                    source,
                    source_handle: Arc::from("event"),
                    value,
                    edge_id: None,
                    sequence: 0,
                });
            }
        });

        self.thread_handle = Some(handle);
    }
}

impl Component for Delay {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Delay" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> { Ok(()) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "trigger" => { self.signal(args); Ok(()) }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        // Cancel any pending delay thread and wait for it
        self.cancel_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
