//! Piezo Buzzer Component - Output
//!
//! Tone generation uses the Johnny-Five approach: OUTPUT mode + `DigitalWrite`
//! toggling at the note's half-period to produce a square wave at the desired
//! frequency. The toggling runs on the Firmata reader thread (via `BoardCommand::Tone`)
//! for tight timing with direct serial access — no channel overhead per toggle.

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentEvent,
    ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
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

pub struct Piezo {
    base: ComponentBase,
    config: PiezoConfig,
    board: Option<Arc<BoardHandle>>,
    is_playing: bool,
    /// Shared cancellation flag for the background song/buzz thread.
    /// Set to `true` by `stop()` so the thread exits early.
    cancel_token: Arc<AtomicBool>,
}

impl Piezo {
    #[must_use]
    pub fn new(id: String, config: PiezoConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            board: None,
            is_playing: false,
            cancel_token: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn buzz(&mut self) -> Result<(), crate::error::RuntimeError> {
        self.stop()?;
        if self.config.r#type != PiezoType::Buzz { return Ok(()); }
        // Fresh token for this buzz
        self.cancel_token = Arc::new(AtomicBool::new(false));
        self.buzz_once(self.config.frequency as u16, self.config.duration)
    }

    fn buzz_once(&mut self, freq: u16, duration_ms: u32) -> Result<(), crate::error::RuntimeError> {
        let board = match &self.board {
            Some(b) => Arc::clone(b),
            None => return Err(crate::error::RuntimeError::BoardNotConnected),
        };

        let pin = self.config.pin;
        let half_period_us = hz_to_half_period_us(freq);
        let sender = self.base.event_sender.clone();
        let source = self.base.id.clone();
        let cancel = Arc::clone(&self.cancel_token);

        std::thread::spawn(move || {
            let _ = board.send_command(BoardCommand::Tone { pin, half_period_us, duration_ms });
            // Only emit auto_stop if we weren't cancelled (avoids stale event after re-trigger)
            if !cancel.load(Ordering::Acquire) {
                if let Some(tx) = sender {
                    let _ = tx.send(ComponentEvent {
                        source,
                        source_handle: Arc::from("_auto_stop"),
                        value: ComponentValue::Bool(false),
                        edge_id: None,
                        sequence: 0,
                    });
                }
            }
        });

        self.is_playing = true;
        self.base.set_value(ComponentValue::Bool(true));
        Ok(())
    }

    fn handle_auto_stop(&mut self) -> Result<(), crate::error::RuntimeError> {
        if let Some(board) = &self.board {
            let _ = board.send_command(BoardCommand::NoTone { pin: self.config.pin });
        }
        self.is_playing = false;
        self.base.set_value(ComponentValue::Bool(false));
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), crate::error::RuntimeError> {
        // Signal any background thread (buzz or song) to exit early
        self.cancel_token.store(true, Ordering::Release);
        self.handle_auto_stop()
    }

    pub fn play(&mut self) -> Result<(), crate::error::RuntimeError> {
        self.stop()?;

        log::info!("Piezo play() called - type: {:?}, song length: {}", self.config.r#type, self.config.song.len());

        if self.config.r#type != PiezoType::Song {
            log::info!("Piezo type is not Song, skipping");
            return Ok(());
        }
        if self.config.song.is_empty() {
            log::info!("Song is empty, falling back to single buzz");
            // Fresh token for this buzz
            self.cancel_token = Arc::new(AtomicBool::new(false));
            return self.buzz_once(self.config.frequency as u16, self.config.duration);
        }

        let board = match &self.board {
            Some(b) => Arc::clone(b),
            None => return Err(crate::error::RuntimeError::BoardNotConnected),
        };

        let song = self.config.song.clone();
        let tempo = self.config.tempo;
        let pin = self.config.pin;
        let sender = self.base.event_sender.clone();
        let source = self.base.id.clone();

        // Fresh token for this playback
        self.cancel_token = Arc::new(AtomicBool::new(false));
        let cancel = Arc::clone(&self.cancel_token);

        log::info!("Playing song with {} notes at tempo {}", song.len(), tempo);

        self.is_playing = true;
        self.base.set_value(ComponentValue::Bool(true));

        // Play song in background thread.
        // Each note sends a Tone command to the reader thread, then sleeps
        // for the note's duration. The reader thread does the tight
        // DigitalWrite toggling. A small silence gap between notes provides
        // articulation so consecutive notes are distinguishable.
        std::thread::spawn(move || {
            let frequencies = note_frequencies();
            let beat_ms = 60000.0 / f64::from(tempo);

            for (note, beats) in song {
                // Check cancellation before each note
                if cancel.load(Ordering::Acquire) {
                    log::info!("Song cancelled, stopping playback");
                    break;
                }

                let duration_ms = (beat_ms * beats) as u64;

                if let Some(note_name) = note {
                    let freq = frequencies.get(note_name.to_lowercase().as_str()).copied().unwrap_or(440);
                    let half_period_us = hz_to_half_period_us(freq);
                    log::info!("Playing note {note_name} ({freq}Hz, half={half_period_us}µs) for {duration_ms}ms");

                    // Small fixed articulation gap to distinguish consecutive notes.
                    let gap: u64 = 20;
                    let tone_duration = duration_ms.saturating_sub(gap) as u32;

                    let _ = board.send_command(BoardCommand::Tone { pin, half_period_us, duration_ms: tone_duration });

                    // Sleep in small increments so we can check cancellation
                    let sleep_end = std::time::Instant::now() + Duration::from_millis(duration_ms);
                    while std::time::Instant::now() < sleep_end {
                        if cancel.load(Ordering::Acquire) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                } else {
                    log::info!("Rest for {duration_ms}ms");
                    let _ = board.send_command(BoardCommand::NoTone { pin });

                    let sleep_end = std::time::Instant::now() + Duration::from_millis(duration_ms);
                    while std::time::Instant::now() < sleep_end {
                        if cancel.load(Ordering::Acquire) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            }

            // Only emit auto_stop if we weren't cancelled
            if !cancel.load(Ordering::Acquire) {
                let _ = board.send_command(BoardCommand::NoTone { pin });

                log::info!("Song finished, emitting auto_stop");
                if let Some(tx) = sender {
                    let _ = tx.send(ComponentEvent {
                        source,
                        source_handle: Arc::from("_auto_stop"),
                        value: ComponentValue::Bool(false),
                        edge_id: None,
                        sequence: 0,
                    });
                }
            }
        });

        Ok(())
    }
}

impl Component for Piezo {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Piezo" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        board.send_command(BoardCommand::SetPinMode { pin: self.config.pin, mode: pin_mode::OUTPUT })?;
        board.send_command(BoardCommand::DigitalWrite { pin: self.config.pin, value: false })?;
        self.board = Some(board);
        Ok(())
    }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "trigger" => {
                match self.config.r#type {
                    PiezoType::Buzz => self.buzz(),
                    PiezoType::Song => self.play(),
                }
            }
            "stop" | "auto_stop" => self.handle_auto_stop(),
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) { let _ = self.stop(); self.board = None; }
}
