//! Interval Component - Generator

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;

const MIN_INTERVAL_MS: u64 = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntervalConfig {
    #[serde(default = "default_interval")]
    pub interval: u64,
    #[serde(default = "default_auto_start", rename = "autoStart")]
    pub auto_start: bool,
}

fn default_interval() -> u64 { 1000 }
fn default_auto_start() -> bool { true }

impl Default for IntervalConfig {
    fn default() -> Self {
        Self { interval: default_interval(), auto_start: default_auto_start() }
    }
}

pub struct Interval {
    base: ComponentBase,
    config: IntervalConfig,
    running: Arc<AtomicBool>,
    task_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Interval {
    pub fn new(id: String, config: IntervalConfig) -> Self {
        let auto_start = config.auto_start;
        let mut interval = Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            running: Arc::new(AtomicBool::new(false)),
            task_handle: None,
        };
        if auto_start {
            interval.start();
        }
        interval
    }

    pub fn start(&mut self) {
        self.stop();
        self.running.store(true, Ordering::SeqCst);

        let interval_ms = self.config.interval.max(MIN_INTERVAL_MS);
        let sender = self.base.event_sender.clone();
        let source = self.base.id.clone();
        let running = self.running.clone();

        let handle = tokio::spawn(async move {
            let start = std::time::Instant::now();
            while running.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(interval_ms)).await;
                if !running.load(Ordering::SeqCst) { break; }

                let elapsed = start.elapsed().as_millis() as f64;
                if let Some(tx) = &sender {
                    let _ = tx.send(ComponentEvent {
                        source: source.clone(),
                        source_handle: "change".to_string(),
                        value: ComponentValue::Number(elapsed),
                        edge_id: None,
                    });
                }
            }
        });

        self.task_handle = Some(handle);
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.task_handle.take() {
            handle.abort();
        }
    }
}

impl Component for Interval {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Interval" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), String> {
        match method {
            "start" => { self.start(); Ok(()) }
            "stop" => { self.stop(); Ok(()) }
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { self.stop(); }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
