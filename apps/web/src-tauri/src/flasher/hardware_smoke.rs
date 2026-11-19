//! Hardware smoke: the desktop flasher on a real board.
//!
//! The modelled bootloaders this module is tested against are transcriptions.
//! This is the check that a real bootloader agrees with them: it flashes
//! `StandardFirmata` and then asks the board for Firmata.
//!
//! It overwrites the firmware on a board, so it never picks one: it is
//! `#[ignore]`d, and even under `--ignored` it does nothing until both the
//! port and the board type are named.
//!
//! ```sh
//! # from apps/web; runs first in the hardware smoke suite, then the runtime
//! # tests run on the freshly flashed board
//! MICROFLOW_HW_PORT=/dev/cu.usbserial-2110 MICROFLOW_HW_FLASH=nano bun run smoke:hardware
//! ```
//!
//! `MICROFLOW_HW_FLASH` is a board id (`uno`, `nano`, `nanoNew`, `mega`,
//! `leonardo`, `micro`). One board per protocol covers the flasher: an Uno or
//! Nano (`STK500v1`), a Mega 2560 (`STK500v2`), a Leonardo or Micro (AVR109).
//! On a Nano, running it once as `nano` and once as `nanoNew` also covers the
//! baud fallback: one of the two starts at the wrong rate.

use super::{BoardType, Flasher};
use std::time::Duration;

#[test]
#[ignore = "flashes a real board: set MICROFLOW_HW_PORT and MICROFLOW_HW_FLASH"]
fn flashes_standard_firmata_and_the_board_then_answers_firmata() {
    let Ok(board_id) = std::env::var("MICROFLOW_HW_FLASH") else {
        eprintln!("MICROFLOW_HW_FLASH is not set: no board was flashed");
        return;
    };
    let board = BoardType::from_id(&board_id)
        .unwrap_or_else(|| panic!("MICROFLOW_HW_FLASH={board_id} is not a board id"));
    let port = std::env::var("MICROFLOW_HW_PORT")
        .expect("MICROFLOW_HW_PORT must name the port to flash; the flash check never picks one");

    Flasher::flash_standard_firmata(&port, board)
        .unwrap_or_else(|e| panic!("flashing {board_id} on {port} failed: {e}"));

    // The board reboots into the fresh sketch, as after a flash in the app.
    std::thread::sleep(Duration::from_millis(2500));
    assert!(
        crate::hardware::detect_firmata(&port).is_some(),
        "flashed {board_id} on {port}, but it does not answer Firmata"
    );
}
