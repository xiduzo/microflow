//! Piezo Buzzer Component — Output. Ported from the desktop runtime.
//!
//! The desktop original drove tone generation by spawning a `std::thread` that
//! issued a `BoardCommand::Tone` (a tight `DigitalWrite` square-wave spin-loop on
//! the Firmata reader thread) and slept for each note's duration. The sans-IO
//! core has no thread and no sub-millisecond timing: `BoardWriter::tone` is
//! best-effort (it just drives the pin high), so pitch fidelity is intentionally
//! coarse. Instead the song/buzz is sequenced as a **scheduled wakeup chain at
//! note granularity**: a flattened step queue is walked one note per
//! `dispatch_internal("note")` callback, each step arming the next `_note` wakeup
//! for its own duration. `stop` cancels the outstanding `_note`.

use crate::runtime::{
    pin_mode, serde_utils, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PiezoType {
    #[default]
    Buzz,
    Song,
}

pub type Note = (Option<String>, f64);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiezoConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub r#type: PiezoType,
    #[serde(default = "default_duration")]
    pub duration: u32,
    #[serde(default = "default_frequency")]
    pub frequency: u32,
    #[serde(default)]
    pub song: Vec<Note>,
    #[serde(default = "default_tempo")]
    pub tempo: u32,
}

fn default_pin() -> u8 { 11 }
fn default_duration() -> u32 { 500 }
fn default_frequency() -> u32 { 440 }
fn default_tempo() -> u32 { 113 }

impl Default for PiezoConfig {
    fn default() -> Self {
        Self { pin: default_pin(), r#type: PiezoType::default(), duration: default_duration(), frequency: default_frequency(), song: Vec::new(), tempo: default_tempo() }
    }
}

/// Get note frequencies (standard piano frequencies in Hz)
fn note_frequencies() -> HashMap<&'static str, u16> {
    let mut m = HashMap::new();
    m.insert("b0", 31);
    m.insert("c1", 33); m.insert("c#1", 35); m.insert("d1", 37); m.insert("d#1", 39);
    m.insert("e1", 41); m.insert("f1", 44); m.insert("f#1", 46); m.insert("g1", 49);
    m.insert("g#1", 52); m.insert("a1", 55); m.insert("a#1", 58); m.insert("b1", 62);
    m.insert("c2", 65); m.insert("c#2", 69); m.insert("d2", 73); m.insert("d#2", 78);
    m.insert("e2", 82); m.insert("f2", 87); m.insert("f#2", 93); m.insert("g2", 98);
    m.insert("g#2", 104); m.insert("a2", 110); m.insert("a#2", 117); m.insert("b2", 123);
    m.insert("c3", 131); m.insert("c#3", 139); m.insert("d3", 147); m.insert("d#3", 156);
    m.insert("e3", 165); m.insert("f3", 175); m.insert("f#3", 185); m.insert("g3", 196);
    m.insert("g#3", 208); m.insert("a3", 220); m.insert("a#3", 233); m.insert("b3", 247);
    m.insert("c4", 262); m.insert("c#4", 277); m.insert("d4", 294); m.insert("d#4", 311);
    m.insert("e4", 330); m.insert("f4", 349); m.insert("f#4", 370); m.insert("g4", 392);
    m.insert("g#4", 415); m.insert("a4", 440); m.insert("a#4", 466); m.insert("b4", 494);
    m.insert("c5", 523); m.insert("c#5", 554); m.insert("d5", 587); m.insert("d#5", 622);
    m.insert("e5", 659); m.insert("f5", 698); m.insert("f#5", 740); m.insert("g5", 784);
    m.insert("g#5", 831); m.insert("a5", 880); m.insert("a#5", 932); m.insert("b5", 988);
    m.insert("c6", 1047); m.insert("c#6", 1109); m.insert("d6", 1175); m.insert("d#6", 1245);
    m.insert("e6", 1319); m.insert("f6", 1397); m.insert("f#6", 1480); m.insert("g6", 1568);
    m.insert("g#6", 1661); m.insert("a6", 1760); m.insert("a#6", 1865); m.insert("b6", 1976);
    m.insert("c7", 2093); m.insert("c#7", 2217); m.insert("d7", 2349); m.insert("d#7", 2489);
    m.insert("e7", 2637); m.insert("f7", 2794); m.insert("f#7", 2960); m.insert("g7", 3136);
    m.insert("g#7", 3322); m.insert("a7", 3520); m.insert("a#7", 3729); m.insert("b7", 3951);
    m.insert("c8", 4186); m.insert("c#8", 4435); m.insert("d8", 4699); m.insert("d#8", 4978);
    m
}

/// Convert frequency (Hz) to half-period (microseconds).
/// J5 approach: tone = round((1/freq) / 2 * `1_000_000`)
fn hz_to_half_period_us(freq: u16) -> u32 {
    if freq == 0 { return 0; }
    500_000 / u32::from(freq)
}

/// One sequenced playback step. `is_tone == false` is a rest (silence).
#[derive(Debug, Clone, Copy)]
struct Step {
    half_period_us: u32,
    duration_ms: u64,
    is_tone: bool,
}

pub struct Piezo {
    base: ComponentBase,
    config: PiezoConfig,
    is_playing: bool,
    /// Flattened note/rest queue for the current playback, walked one step per
    /// `_note` wakeup. Empty when idle.
    steps: Vec<Step>,
    /// Index of the next step to play in `steps`.
    cursor: usize,
}

impl Piezo {
    #[must_use]
    pub fn new(id: String, config: PiezoConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            is_playing: false,
            steps: Vec::new(),
            cursor: 0,
        }
    }

    fn buzz(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.stop(ctx)?;
        if self.config.r#type != PiezoType::Buzz { return Ok(()); }
        let steps = vec![Step {
            half_period_us: hz_to_half_period_us(self.config.frequency as u16),
            duration_ms: u64::from(self.config.duration),
            is_tone: true,
        }];
        self.start_playback(steps, ctx)
    }

    fn play(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.stop(ctx)?;

        if self.config.r#type != PiezoType::Song {
            return Ok(());
        }
        if self.config.song.is_empty() {
            // Empty song falls back to a single buzz, matching the desktop.
            let steps = vec![Step {
                half_period_us: hz_to_half_period_us(self.config.frequency as u16),
                duration_ms: u64::from(self.config.duration),
                is_tone: true,
            }];
            return self.start_playback(steps, ctx);
        }

        let frequencies = note_frequencies();
        let beat_ms = 60000.0 / f64::from(self.config.tempo);
        let steps: Vec<Step> = self
            .config
            .song
            .iter()
            .map(|(note, beats)| {
                let duration_ms = (beat_ms * beats) as u64;
                match note {
                    Some(note_name) => {
                        let freq = frequencies
                            .get(note_name.to_lowercase().as_str())
                            .copied()
                            .unwrap_or(440);
                        Step { half_period_us: hz_to_half_period_us(freq), duration_ms, is_tone: true }
                    }
                    None => Step { half_period_us: 0, duration_ms, is_tone: false },
                }
            })
            .collect();

        self.start_playback(steps, ctx)
    }

    /// Begin a fresh sequence: stash the step queue, mark playing, and arm the
    /// first `_note` wakeup immediately (delay 0). The runtime delivers it as
    /// `dispatch_internal("note", …)` next turn, which plays the step and chains.
    fn start_playback(&mut self, steps: Vec<Step>, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if steps.is_empty() {
            return Ok(());
        }
        self.steps = steps;
        self.cursor = 0;
        self.is_playing = true;
        self.base.set_value(ComponentValue::Bool(true));
        ctx.schedule_wakeup("_note", 0);
        Ok(())
    }

    /// Play the step at `cursor`, advance, and arm the next `_note` wakeup for the
    /// just-started step's duration. When the queue is exhausted, finalize.
    fn advance(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if !self.is_playing {
            return Ok(());
        }
        let Some(step) = self.steps.get(self.cursor).copied() else {
            // Sequence finished naturally — clear the pin and reset state.
            return self.handle_auto_stop(ctx);
        };
        self.cursor += 1;

        if step.is_tone {
            ctx.board().tone(self.config.pin, step.half_period_us, step.duration_ms as u32)?;
        } else {
            ctx.board().no_tone(self.config.pin)?;
        }
        // Hold this step for its duration, then wake to play the next one.
        ctx.schedule_wakeup("_note", step.duration_ms);
        Ok(())
    }

    fn handle_auto_stop(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().no_tone(self.config.pin)?;
        self.is_playing = false;
        self.steps.clear();
        self.cursor = 0;
        self.base.set_value(ComponentValue::Bool(false));
        Ok(())
    }

    fn stop(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // Cancel any outstanding note wakeup so a re-trigger starts clean.
        ctx.cancel_wakeup("_note");
        self.handle_auto_stop(ctx)
    }
}

impl Component for Piezo {
    fn ports() -> &'static [&'static str] { &["trigger", "stop"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Piezo" }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> { Some(self) }

    fn dispatch(&mut self, method: &str, _args: ComponentValue, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        match method {
            "trigger" => {
                match self.config.r#type {
                    PiezoType::Buzz => self.buzz(ctx),
                    PiezoType::Song => self.play(ctx),
                }
            }
            "stop" => self.stop(ctx),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn dispatch_internal(&mut self, method: &str, _value: ComponentValue, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        match method {
            // Scheduled wakeup that walks the note queue; re-arms itself per step
            // and finalizes when the sequence is exhausted. Never reachable from an edge.
            "note" => self.advance(ctx),
            _ => Err(RuntimeError::ComponentError(format!("Unknown internal method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        // No board access here (the trait's destroy has no ctx); just clear
        // internal playback state. The pin is left to the runtime's teardown.
        self.is_playing = false;
        self.steps.clear();
        self.cursor = 0;
    }
}

impl HardwareComponent for Piezo {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pin, pin_mode::OUTPUT)?;
        ctx.board().digital_write(self.config.pin, false)?;
        Ok(())
    }
}

impl ComponentBuilder for Piezo {
    type Config = PiezoConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
