//! Piezo Buzzer Component - Output

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

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
fn default_tempo() -> u32 { 120 }

impl Default for PiezoConfig {
    fn default() -> Self {
        Self { pin: default_pin(), r#type: PiezoType::default(), duration: default_duration(), frequency: default_frequency(), song: Vec::new(), tempo: default_tempo() }
    }
}

/// Get note frequencies (standard piano frequencies)
fn note_frequencies() -> HashMap<&'static str, u16> {
    let mut m = HashMap::new();
    // Octave 0
    m.insert("b0", 31);
    // Octave 1
    m.insert("c1", 33); m.insert("c#1", 35); m.insert("d1", 37); m.insert("d#1", 39);
    m.insert("e1", 41); m.insert("f1", 44); m.insert("f#1", 46); m.insert("g1", 49);
    m.insert("g#1", 52); m.insert("a1", 55); m.insert("a#1", 58); m.insert("b1", 62);
    // Octave 2
    m.insert("c2", 65); m.insert("c#2", 69); m.insert("d2", 73); m.insert("d#2", 78);
    m.insert("e2", 82); m.insert("f2", 87); m.insert("f#2", 93); m.insert("g2", 98);
    m.insert("g#2", 104); m.insert("a2", 110); m.insert("a#2", 117); m.insert("b2", 123);
    // Octave 3
    m.insert("c3", 131); m.insert("c#3", 139); m.insert("d3", 147); m.insert("d#3", 156);
    m.insert("e3", 165); m.insert("f3", 175); m.insert("f#3", 185); m.insert("g3", 196);
    m.insert("g#3", 208); m.insert("a3", 220); m.insert("a#3", 233); m.insert("b3", 247);
    // Octave 4 (middle)
    m.insert("c4", 262); m.insert("c#4", 277); m.insert("d4", 294); m.insert("d#4", 311);
    m.insert("e4", 330); m.insert("f4", 349); m.insert("f#4", 370); m.insert("g4", 392);
    m.insert("g#4", 415); m.insert("a4", 440); m.insert("a#4", 466); m.insert("b4", 494);
    // Octave 5
    m.insert("c5", 523); m.insert("c#5", 554); m.insert("d5", 587); m.insert("d#5", 622);
    m.insert("e5", 659); m.insert("f5", 698); m.insert("f#5", 740); m.insert("g5", 784);
    m.insert("g#5", 831); m.insert("a5", 880); m.insert("a#5", 932); m.insert("b5", 988);
    // Octave 6
    m.insert("c6", 1047); m.insert("c#6", 1109); m.insert("d6", 1175); m.insert("d#6", 1245);
    m.insert("e6", 1319); m.insert("f6", 1397); m.insert("f#6", 1480); m.insert("g6", 1568);
    m.insert("g#6", 1661); m.insert("a6", 1760); m.insert("a#6", 1865); m.insert("b6", 1976);
    // Octave 7
    m.insert("c7", 2093); m.insert("c#7", 2217); m.insert("d7", 2349); m.insert("d#7", 2489);
    m.insert("e7", 2637); m.insert("f7", 2794); m.insert("f#7", 2960); m.insert("g7", 3136);
    m.insert("g#7", 3322); m.insert("a7", 3520); m.insert("a#7", 3729); m.insert("b7", 3951);
    // Octave 8
    m.insert("c8", 4186); m.insert("c#8", 4435); m.insert("d8", 4699); m.insert("d#8", 4978);
    m
}

pub struct Piezo {
    base: ComponentBase,
    config: PiezoConfig,
    board: Option<Arc<BoardHandle>>,
    is_playing: bool,
}

impl Piezo {
    pub fn new(id: String, config: PiezoConfig) -> Self {
        Self { base: ComponentBase::new(id, ComponentValue::Bool(false)), config, board: None, is_playing: false }
    }

    pub fn buzz(&mut self) -> Result<(), String> {
        self.stop()?;
        if self.config.r#type != PiezoType::Buzz { return Ok(()); }
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.analog_write(self.config.pin, 128))?;
            
            // Schedule automatic stop after duration using std::thread
            let duration_ms = self.config.duration;
            let sender = self.base.event_sender.clone();
            let source = self.base.id.clone();
            
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(duration_ms as u64));
                if let Some(tx) = sender {
                    let _ = tx.send(ComponentEvent {
                        source,
                        source_handle: Arc::from("_auto_stop"),
                        value: ComponentValue::Bool(false),
                        edge_id: None,
                        sequence: 0,  // Will be set by FlowRuntime when sequence tracking is enabled
                    });
                }
            });
        }
        self.is_playing = true;
        self.base.set_value(ComponentValue::Bool(true));
        Ok(())
    }
    
    fn handle_auto_stop(&mut self) -> Result<(), String> {
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.analog_write(self.config.pin, 0))?;
        }
        self.is_playing = false;
        self.base.set_value(ComponentValue::Bool(false));
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.handle_auto_stop()
    }

    pub fn play(&mut self) -> Result<(), String> {
        self.stop()?;
        
        log::info!("Piezo play() called - type: {:?}, song length: {}", self.config.r#type, self.config.song.len());
        
        if self.config.r#type != PiezoType::Song { 
            log::info!("Piezo type is not Song, skipping");
            return Ok(()); 
        }
        if self.config.song.is_empty() { 
            log::info!("Song is empty, skipping");
            return Ok(()); 
        }
        
        let board = match &self.board {
            Some(b) => Arc::clone(b),
            None => return Err("No board connected".to_string()),
        };
        
        let song = self.config.song.clone();
        let tempo = self.config.tempo;
        let pin = self.config.pin;
        let sender = self.base.event_sender.clone();
        let source = self.base.id.clone();
        
        log::info!("Playing song with {} notes at tempo {}", song.len(), tempo);
        
        self.is_playing = true;
        self.base.set_value(ComponentValue::Bool(true));
        
        // Play song in background thread
        std::thread::spawn(move || {
            let frequencies = note_frequencies();
            // Beat duration in ms (tempo is BPM, so 60000/tempo = ms per beat)
            let beat_ms = 60000.0 / tempo as f64;
            
            for (note, beats) in song {
                let duration_ms = (beat_ms * beats) as u64;
                
                if let Some(note_name) = note {
                    // Play the note
                    let _freq = frequencies.get(note_name.to_lowercase().as_str()).copied().unwrap_or(440);
                    log::info!("Playing note {} for {}ms", note_name, duration_ms);
                    // For PWM-based tone, we write a mid-value to create sound
                    let _ = board.with_board(|conn| conn.analog_write(pin, 128));
                    // Play for most of the duration, tiny gap for articulation
                    let gap = 5.min(duration_ms / 10); // 5ms or 10% of note, whichever is smaller
                    std::thread::sleep(std::time::Duration::from_millis(duration_ms.saturating_sub(gap)));
                    let _ = board.with_board(|conn| conn.analog_write(pin, 0));
                    if gap > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(gap));
                    }
                } else {
                    // Rest - silence
                    log::info!("Rest for {}ms", duration_ms);
                    let _ = board.with_board(|conn| conn.analog_write(pin, 0));
                    std::thread::sleep(std::time::Duration::from_millis(duration_ms));
                }
            }
            
            log::info!("Song finished, emitting auto_stop");
            // Song finished - emit auto_stop event
            if let Some(tx) = sender {
                let _ = tx.send(ComponentEvent {
                    source,
                    source_handle: Arc::from("_auto_stop"),
                    value: ComponentValue::Bool(false),
                    edge_id: None,
                    sequence: 0,  // Will be set by FlowRuntime when sequence tracking is enabled
                });
            }
        });
        
        Ok(())
    }
}

impl Component for Piezo {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Piezo" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.with_board(|conn| {
            conn.set_pin_mode(self.config.pin, pin_mode::PWM)?;
            conn.analog_write(self.config.pin, 0)
        })?;
        self.board = Some(board);
        Ok(())
    }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), String> {
        match method {
            "trigger" => {
                // Trigger plays buzz or song depending on type
                match self.config.r#type {
                    PiezoType::Buzz => self.buzz(),
                    PiezoType::Song => self.play(),
                }
            }
            "stop" | "auto_stop" => self.handle_auto_stop(),
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { let _ = self.stop(); self.board = None; }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
