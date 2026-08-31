//! Music host-audio node on core's [`Component`] trait.
//!
//! Piezo's sibling for the laptop's speakers, holding a stack of records: `play`
//! and `stop` drive the selected one, `set` selects another (by index or by
//! name), and every record also gets its **own** dynamic port named after it, so
//! a button can be wired straight to one record. Dynamic ports are the same
//! open-port outlier the `Function` node uses: `ports()` declares only the fixed
//! set, and `dispatch`'s catch-all arm resolves anything else against the
//! record names in the config.
//!
//! Audio is not a cloud service, but it is the same sans-IO shape as MIDI
//! (ADR-0009) — a `dispatch` records a [`CloudRequestKind::AudioPlay`] /
//! [`CloudRequestKind::AudioStop`] and the host's `EffectsSink::perform_cloud`
//! plays it (both hosts share one `AudioPerformer` in the webview).
//!
//! The audio files never enter the runtime: the request carries the node id
//! (`CloudRequest::source`) plus the record's index, and the host resolves the
//! `src` data URL from the flow it already holds. Multi-megabyte base64 riding
//! through every effects turn would be the whole cost of the feature.
//!
//! Track end is reported back by the host dispatching `stop` on the node — the
//! same port a wire can drive — so `value` falls to false either way and no
//! extra re-entry seam exists to keep in sync.
//!
//! [`Component`]: crate::runtime::Component

use crate::runtime::{
    CloudRequestKind, Component, ComponentBase, ComponentBuilder, ComponentValue, DiagnosticLevel,
    RuntimeContext, RuntimeError,
};
use std::borrow::Cow;

pub use crate::config::music::{MusicConfig, MusicTrack};

pub struct Music {
    base: ComponentBase,
    config: MusicConfig,
    /// The selected record. Starts at the configured one and moves with `set`
    /// or a dynamic per-record port.
    current: usize,
}

impl Music {
    /// Emits the selected record's name, so the canvas (and any wired node) can
    /// follow a selection the runtime made.
    pub const E_TRACK: &'static str = "track";

    #[must_use]
    pub fn new(id: String, config: MusicConfig) -> Self {
        let current = config.track.min(config.tracks.len().saturating_sub(1));
        Self { base: ComponentBase::new(id, ComponentValue::Bool(false)), config, current }
    }

    /// The record `args` names: a number selects by index, anything else by
    /// name (case-insensitive). `None` when nothing matches.
    fn resolve(&self, args: &ComponentValue) -> Option<usize> {
        if let ComponentValue::String(name) = args {
            return self.index_of(name);
        }
        let n = args.as_number()?;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let index = n.max(0.0) as usize;
        (index < self.config.tracks.len()).then_some(index)
    }

    /// How an unmatched `set` value reads on the node's warning badge.
    fn describe(args: &ComponentValue) -> String {
        match args {
            ComponentValue::String(s) => s.clone(),
            ComponentValue::Number(n) => n.to_string(),
            other => format!("{other:?}"),
        }
    }

    fn index_of(&self, name: &str) -> Option<usize> {
        self.config
            .tracks
            .iter()
            .position(|track| track.name.eq_ignore_ascii_case(name.trim()))
    }

    /// Select a record and announce it. Emits even when the selection is
    /// unchanged, so a `set` always confirms what is selected.
    fn select(&mut self, index: usize) {
        self.current = index;
        let name = self.config.tracks[index].name.clone();
        self.base
            .emit_with_value(Self::E_TRACK, Cow::Owned(ComponentValue::String(name)));
    }

    fn play(&mut self, ctx: &mut RuntimeContext) {
        let Some(track) = u32::try_from(self.current).ok().filter(|_| !self.config.tracks.is_empty())
        else {
            // Nothing to play is a setup mistake, not a runtime fault: say so on
            // the node instead of failing the turn.
            ctx.report_diagnostic(DiagnosticLevel::Warning, "No songs added yet");
            return;
        };
        ctx.clear_diagnostic();
        ctx.request_cloud(CloudRequestKind::AudioPlay {
            track,
            volume: self.config.volume.clamp(0.0, 1.0),
            r#loop: self.config.r#loop,
        });
        self.base.set_value(ComponentValue::Bool(true));
    }

    fn stop(&mut self, ctx: &mut RuntimeContext) {
        ctx.request_cloud(CloudRequestKind::AudioStop);
        self.base.set_value(ComponentValue::Bool(false));
    }
}

impl Component for Music {
    fn ports() -> &'static [&'static str] {
        &["play", "stop", "set"]
    }

    fn emits() -> &'static [&'static str] {
        &[ComponentBase::VALUE_HANDLE, Self::E_TRACK]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Music"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            // Re-triggering while playing restarts the record (the host rewinds
            // the running element), matching Piezo's `trigger`.
            "play" => {
                self.play(ctx);
                Ok(())
            }
            "stop" => {
                self.stop(ctx);
                Ok(())
            }
            // Select without playing, so a selector (counter, dial, monitor) can
            // cue a record that something else triggers.
            "set" => {
                match self.resolve(&args) {
                    Some(index) => self.select(index),
                    None => ctx.report_diagnostic(
                        DiagnosticLevel::Warning,
                        format!("No song matches `{}`", Self::describe(&args)),
                    ),
                }
                Ok(())
            }
            // A dynamic per-record port: select that record and play it. Unknown
            // names are a real error (a stale edge to a deleted record).
            name => match self.index_of(name) {
                Some(index) => {
                    self.select(index);
                    self.play(ctx);
                    Ok(())
                }
                None => Err(RuntimeError::ComponentError(format!("Unknown method: {name}"))),
            },
        }
    }
}

impl ComponentBuilder for Music {
    type Config = MusicConfig;
    fn build(id: String, config: MusicConfig) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cloud::test_support::recorded_cloud_requests;
    use crate::runtime::{ComponentEvent, EventSink};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    fn config(names: &[&str]) -> MusicConfig {
        MusicConfig {
            tracks: names.iter().map(|n| MusicTrack { name: (*n).to_string() }).collect(),
            volume: 2.0,
            r#loop: true,
            track: 0,
        }
    }

    fn node(names: &[&str]) -> Music {
        let mut node = Music::new("m-1".into(), config(names));
        node.set_sink(Rc::new(RefCell::new(VecDeque::new())) as EventSink);
        node
    }

    fn drain(node: &Music) -> Vec<ComponentEvent> {
        node.base.sink.as_ref().expect("sink").borrow_mut().drain(..).collect()
    }

    fn tracks_of(reqs: &[CloudRequestKind]) -> Vec<u32> {
        reqs.iter()
            .filter_map(|kind| match kind {
                CloudRequestKind::AudioPlay { track, .. } => Some(*track),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn play_requests_the_selected_record_with_clamped_volume_and_loop() {
        let mut node = node(&["intro", "outro"]);
        let reqs = recorded_cloud_requests("m-1", |ctx| {
            node.dispatch("play", ComponentValue::Bool(true), ctx).expect("play ok");
            node.dispatch("stop", ComponentValue::Bool(false), ctx).expect("stop ok");
        });
        match &reqs[0] {
            CloudRequestKind::AudioPlay { track, volume, r#loop } => {
                assert_eq!(*track, 0, "the configured record plays");
                assert!((*volume - 1.0).abs() < f32::EPSILON, "volume is clamped to 1.0");
                assert!(*r#loop, "loop rides through to the host");
            }
            other => panic!("expected AudioPlay, got {other:?}"),
        }
        assert!(matches!(reqs[1], CloudRequestKind::AudioStop));
        assert_eq!(node.base.value, ComponentValue::Bool(false), "stop clears the value");
    }

    #[test]
    fn set_selects_by_index_or_name_without_playing() {
        let mut node = node(&["intro", "outro"]);
        let reqs = recorded_cloud_requests("m-1", |ctx| {
            node.dispatch("set", ComponentValue::Number(1.0), ctx).expect("set by index");
            node.dispatch("set", ComponentValue::String("INTRO".into()), ctx).expect("set by name");
        });
        assert!(reqs.is_empty(), "`set` selects, it does not play");
        assert_eq!(node.current, 0, "the name match wins last");
        let names: Vec<_> = drain(&node)
            .into_iter()
            .filter(|e| e.source_handle.as_ref() == Music::E_TRACK)
            .map(|e| e.value)
            .collect();
        assert_eq!(
            names,
            vec![
                ComponentValue::String("outro".into()),
                ComponentValue::String("intro".into())
            ]
        );
    }

    #[test]
    fn a_records_own_port_selects_it_and_plays_it() {
        let mut node = node(&["intro", "outro"]);
        let reqs = recorded_cloud_requests("m-1", |ctx| {
            node.dispatch("outro", ComponentValue::Bool(true), ctx).expect("record port");
        });
        assert_eq!(tracks_of(&reqs), vec![1]);
        assert_eq!(node.current, 1);
    }

    #[test]
    fn an_edge_to_a_deleted_record_is_an_error() {
        let mut node = node(&["intro"]);
        recorded_cloud_requests("m-1", |ctx| {
            node.dispatch("gone", ComponentValue::Bool(true), ctx)
                .expect_err("a stale record port must not silently do nothing");
        });
    }

    #[test]
    fn playing_with_no_records_warns_on_the_node_instead_of_calling_the_host() {
        let mut node = node(&[]);
        let reqs = recorded_cloud_requests("m-1", |ctx| {
            node.dispatch("play", ComponentValue::Bool(true), ctx).expect("play ok");
        });
        assert!(reqs.is_empty(), "no record means nothing for the host to play");
        assert_eq!(node.base.value, ComponentValue::Bool(false));
    }

    #[test]
    fn a_configured_selection_out_of_range_falls_back_to_the_first_record() {
        let node = Music::new("m-1".into(), MusicConfig { track: 9, ..config(&["intro", "outro"]) });
        assert_eq!(node.current, 1, "clamped to the last record, never out of bounds");
    }
}
