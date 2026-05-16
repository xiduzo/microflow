//! Tauri-facing LLM glue: the `llm_sync_providers` / `llm_test_provider`
//! commands. The runtime-side capability trait, registry, and provider impls
//! live in `runtime/services/llm.rs`; this module exists only to wire those
//! into Tauri's invoke handler. See `docs/adr/0002-per-capability-service-traits.md`.

pub mod commands;
