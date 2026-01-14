//! Flashing protocols

mod avr109;
mod stk500v1;

pub use avr109::Avr109Flasher;
pub use stk500v1::Stk500v1Flasher;

/// Supported flashing protocols
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Stk500v1,
    Stk500v2,
    Avr109,
}
