//! Delay Component - Control

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
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
    pending_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Delay {
    #[must_use] 
    pub fn new(id: String, config: DelayConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            pending_handle: None,
        }
    }

    pub fn signal(&mut self, value: ComponentValue) {
        if self.config.forget_previous {
            if let Some(handle) = self.pending_handle.take() {
                handle.abort();
            }
        }

        let delay_ms = self.config.delay;
        let sender = self.base.event_sender.clone();
        let source = self.base.id.clone();

        // Store value without emitting change (delay component stores input, emits later)
        self.base.value = value.clone();

        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            if let Some(tx) = sender {
                let _ = tx.send(ComponentEvent {
                    source,
                    source_handle: Arc::from("event"),
                    value,
                    edge_id: None,
                    sequence: 0,  // Will be set by FlowRuntime when sequence tracking is enabled
                });
            }
        });

        self.pending_handle = Some(handle);
    }
}

impl Component for Delay {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Delay" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "trigger" => { self.signal(args); Ok(()) }
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    fn destroy(&mut self) {
        if let Some(handle) = self.pending_handle.take() { handle.abort(); }
    }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
