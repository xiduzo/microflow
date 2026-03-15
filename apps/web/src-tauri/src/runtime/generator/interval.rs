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
    started: bool,
}

impl Interval {
    #[must_use] 
    pub fn new(id: String, config: IntervalConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            running: Arc::new(AtomicBool::new(false)),
            started: false,
        }
    }

    pub fn start(&mut self) {
        if self.base.event_sender.is_none() {
            log::warn!("Interval {} cannot start: no event sender", self.base.id);
            return;
        }
        
        self.stop();
        self.running.store(true, Ordering::SeqCst);
        self.started = true;

        let interval_ms = self.config.interval.max(MIN_INTERVAL_MS);
        let sender = self.base.event_sender.clone();
        let source = self.base.id.clone();
        let running = self.running.clone();

        log::info!("Interval {source} starting with {interval_ms}ms interval");

        std::thread::spawn(move || {
            log::info!("Interval {source} thread started");
            let start = std::time::Instant::now();
            let mut tick_count = 0u64;
            
            while running.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(interval_ms));
                if !running.load(Ordering::SeqCst) { break; }

                tick_count += 1;
                let elapsed = start.elapsed().as_millis() as f64;
                
                if let Some(tx) = &sender {
                    match tx.send(ComponentEvent {
                        source: source.clone(),
                        source_handle: Arc::from("event"),
                        value: ComponentValue::Number(elapsed),
                        edge_id: None,
                        sequence: 0,  // Will be set by FlowRuntime when sequence tracking is enabled
                    }) {
                        Ok(()) => {
                            if tick_count <= 3 || tick_count % 10 == 0 {
                                log::info!("Interval {source} tick #{tick_count}: elapsed {elapsed}ms");
                            }
                        }
                        Err(e) => {
                            log::error!("Interval {source} send failed: {e}");
                            break;
                        }
                    }
                }
            }
            log::info!("Interval {source} thread stopped after {tick_count} ticks");
        });
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.started = false;
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
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    fn destroy(&mut self) { self.stop(); }
    
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { 
        self.base.event_sender.clone() 
    }
    
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { 
        self.base.event_sender = Some(sender);
        // Auto-start after sender is set
        if self.config.auto_start && !self.started {
            log::info!("Interval {} auto-starting after sender set", self.base.id);
            self.start();
        }
    }
}
