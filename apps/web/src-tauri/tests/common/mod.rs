//! Common test utilities for integration tests
//!
//! Provides mock implementations and shared helpers for testing
//! component lifecycle, edge routing, and event propagation.

pub mod mock_board;
pub mod mock_component;

#[allow(unused_imports)]
pub use mock_board::MockBoardHandle;
pub use mock_component::{ComponentEvent, ComponentValue, MockComponent};
