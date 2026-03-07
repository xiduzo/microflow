//! Oscillator Component - Generator

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Waveform {
    #[default]
    Sinus,
    Square,
    Sawtooth,
    Triangle,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OscillatorConfig {
    #[serde(default)]
    pub waveform: Waveform,
    #[serde(default = "default_period")]
    pub period: f64,
    #[serde(default = "default_amplitude")]
    pub amplitude: f64,
    #[serde(default)]
    pub phase: f64,
    #[serde(default)]
    pub shift: f64,
    #[serde(default = "default_auto_start", rename = "autoStart")]
    pub auto_start: bool,
}

fn default_period() -> f64 { 1000.0 }
fn default_amplitude() -> f64 { 1.0 }
fn default_auto_start() -> bool { true }

impl Default for OscillatorConfig {
    fn default() -> Self {
        Self {
            waveform: Waveform::default(),
            period: default_period(),
            amplitude: default_amplitude(),
            phase: 0.0,
            shift: 0.0,
            auto_start: default_auto_start(),
        }
    }
}

pub struct Oscillator {
    base: ComponentBase,
    config: OscillatorConfig,
    running: Arc<AtomicBool>,
    started: bool,
}

impl Oscillator {
    pub fn new(id: String, config: OscillatorConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            running: Arc::new(AtomicBool::new(false)),
            started: false,
        }
    }

    pub fn start(&mut self) {
        if self.base.event_sender.is_none() {
            log::warn!("Oscillator {} cannot start: no event sender", self.base.id);
            return;
        }
        
        self.stop();
        self.running.store(true, Ordering::SeqCst);
        self.started = true;

        let config = self.config.clone();
        let sender = self.base.event_sender.clone();
        let source = self.base.id.clone();
        let running = self.running.clone();

        log::info!("Oscillator {} starting", source);

        std::thread::spawn(move || {
            log::info!("Oscillator {} thread started", source);
            let start = std::time::Instant::now();
            let refresh_rate = 1000 / 60; // 60 FPS

            while running.load(Ordering::SeqCst) {
                let elapsed = start.elapsed().as_millis() as f64;
                let value = calculate_waveform(&config, elapsed);

                if let Some(tx) = &sender {
                    if tx.send(ComponentEvent {
                        source: source.clone(),
                        source_handle: Arc::from("value"),
                        value: ComponentValue::Number(value),
                        edge_id: None,
                        sequence: 0,  // Will be set by FlowRuntime when sequence tracking is enabled
                    }).is_err() {
                        break;
                    }
                }

                std::thread::sleep(Duration::from_millis(refresh_rate));
            }
            log::info!("Oscillator {} thread stopped", source);
        });
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.started = false;
    }

    pub fn reset(&mut self) {
        let was_running = self.running.load(Ordering::SeqCst);
        self.stop();
        if was_running { self.start(); }
    }
}

fn calculate_waveform(config: &OscillatorConfig, timestamp: f64) -> f64 {
    match config.waveform {
        Waveform::Sinus => sinus(config, timestamp),
        Waveform::Square => square(config, timestamp),
        Waveform::Sawtooth => sawtooth(config, timestamp),
        Waveform::Triangle => triangle(config, timestamp),
        Waveform::Random => random(config),
    }
}

fn sinus(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let t = timestamp + config.phase;
    let freq0 = 2.0 * std::f64::consts::PI / config.period;
    config.amplitude * (t * freq0).sin() + config.shift
}

fn square(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let mut t = timestamp + config.phase;
    let value = if t >= 0.0 {
        if t >= config.period { t %= config.period; }
        if t * 2.0 < config.period { config.amplitude } else { -config.amplitude }
    } else {
        t = -t;
        if t >= config.period { t %= config.period; }
        if t * 2.0 < config.period { -config.amplitude } else { config.amplitude }
    };
    value + config.shift
}

fn sawtooth(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let mut t = timestamp + config.phase;
    let freq2 = 2.0 / config.period;
    let value = if t >= 0.0 {
        if t >= config.period { t %= config.period; }
        config.amplitude * (-1.0 + t * freq2)
    } else {
        t = -t;
        if t >= config.period { t %= config.period; }
        config.amplitude * (1.0 - t * freq2)
    };
    value + config.shift
}

fn triangle(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let mut t = timestamp + config.phase;
    if t < 0.0 { t = -t; }
    if t >= config.period { t %= config.period; }
    let freq4 = 4.0 / config.period;
    let value = if t * 2.0 < config.period {
        config.amplitude * (-1.0 + t * freq4)
    } else {
        config.amplitude * (3.0 - t * freq4)
    };
    value + config.shift
}

fn random(config: &OscillatorConfig) -> f64 {
    (config.shift + config.amplitude) * rand::random::<f64>()
}

impl Component for Oscillator {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Oscillator" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), String> {
        match method {
            "start" => { self.start(); Ok(()) }
            "stop" => { self.stop(); Ok(()) }
            "reset" => { self.reset(); Ok(()) }
            _ => Err(format!("Unknown method: {}", method)),
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
            log::info!("Oscillator {} auto-starting after sender set", self.base.id);
            self.start();
        }
    }
}
