//! The board's safe state — the bytes a Runtime Host writes before it lets go of
//! a board, so nothing the flow drove stays driven.
//!
//! One encoder for both hosts: the browser link writes it before closing a
//! healthy port (through `microflow-firmata-wasm`'s `encodeSafeState`), the
//! desktop actor before it drops a board session.
//!
//! `SYSTEM_RESET` alone is not enough. `StandardFirmata`'s `systemResetCallback`
//! re-runs `setPinModeCallback(pin, OUTPUT)` on every digital pin, which only
//! drives a pin LOW when it was in PWM mode; a pin's output latch is otherwise
//! left as it was. Two cases end HIGH:
//!
//! - an OUTPUT pin the flow left HIGH stays HIGH;
//! - a pull-up input (`PIN_MODE_PULLUP`, or a legacy INPUT written 1) has its
//!   latch set for the pull-up, so the reset turns it into an OUTPUT driven
//!   HIGH.
//!
//! So the sequence is: every port written 0 (OUTPUT pins go LOW even on firmware
//! that ignores the reset), `SYSTEM_RESET` (reporting off, servos detached, I2C
//! off, PWM pins LOW, every digital pin OUTPUT), then every port written 0 again
//! (now every digital pin is an OUTPUT, the former pull-ups included). A port
//! write never touches pins in ANALOG, PWM or SERVO mode, so analog inputs stay
//! analog inputs.

use super::DIGITAL_MESSAGE;

/// `SYSTEM_RESET`: a single unframed byte. `StandardFirmata` answers it with
/// `systemResetCallback` — the same defaults it boots into, minus the latch
/// reset a real reboot would do.
pub const SYSTEM_RESET: u8 = 0xFF;

/// A `DIGITAL_MESSAGE` addresses its port in the low nibble: 16 ports, 128 pins.
const MAX_PORTS: usize = 16;

/// The safe-state bytes for a board with `pin_count` Firmata pins: ports zeroed,
/// `SYSTEM_RESET`, ports zeroed again (see the module docs for why both).
///
/// `pin_count` is the length of the detection codec's pin table. A table one pin
/// too long (the capability response's trailing `127`) at most adds a port the
/// firmware ignores (`digitalWriteCallback` checks `port < TOTAL_PORTS`); an
/// empty table — no capability response yet — yields the reset alone.
// TODO(track I): take the board pin profile once it lands, instead of a count.
#[must_use]
pub fn encode_safe_state(pin_count: usize) -> Vec<u8> {
    let ports = pin_count.div_ceil(8).min(MAX_PORTS);
    let zero_ports = (0..ports).flat_map(|port| [DIGITAL_MESSAGE | port as u8, 0, 0]);
    let mut out = Vec::with_capacity(ports * 6 + 1);
    out.extend(zero_ports.clone());
    out.push(SYSTEM_RESET);
    out.extend(zero_ports);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zeroes_every_port_around_the_reset() {
        let ports = [0x90, 0, 0, 0x91, 0, 0, 0x92, 0, 0];
        let mut expected = ports.to_vec();
        expected.push(SYSTEM_RESET);
        expected.extend(ports);
        assert_eq!(encode_safe_state(20), expected);
    }

    #[test]
    fn with_no_pin_table_only_the_reset() {
        assert_eq!(encode_safe_state(0), vec![SYSTEM_RESET]);
    }

    #[test]
    fn caps_at_the_sixteen_addressable_ports() {
        let bytes = encode_safe_state(300);
        assert_eq!(bytes.len(), 16 * 6 + 1);
        assert_eq!(bytes[16 * 3 - 3], 0x9F, "last port addressed is 15");
    }
}
