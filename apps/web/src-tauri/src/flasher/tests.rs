//! The desktop flasher against modelled boards.
//!
//! Each test flashes a small image through [`flash_image`] onto a board that
//! exists only as its bootloader model, behind a recording port (`SimSerial`).
//! It asserts what ended up in the board's flash and, for the paths where the
//! order and timing of port calls is the behaviour (reset, re-enumeration),
//! the transcript of those calls.

use super::sim_serial::SimSerial;
use super::{flash_image, BoardType};
use microflow_core::flasher::sim::{Exit, SimBootloader};
use microflow_core::flasher::{firmware, hex};

const BRIDGE_PORT: &str = "/dev/cu.usbserial-110";
const LEONARDO_PORT: &str = "/dev/cu.usbmodem1101";

/// A flash image of `len` bytes in which every page is different.
fn image(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 7 + i / 128 + 3) as u8).collect()
}

/// A board behind a USB-serial bridge, about to be flashed with `image`.
fn bridged(boot: SimBootloader, image: &[u8], page: usize) -> SimSerial {
    SimSerial::bridged(BRIDGE_PORT, boot).naming_pages_of(image, page)
}

/// A Leonardo whose bootloader shows up on `bootloader_port` 900 ms after the
/// 1200-baud touch.
fn leonardo(boot: SimBootloader, bootloader_port: &str, image: &[u8]) -> SimSerial {
    SimSerial::native_usb(LEONARDO_PORT, bootloader_port, 900, boot).naming_pages_of(image, 128)
}

/// Compare a transcript with the expected one, printing the whole of what
/// happened on a mismatch.
#[track_caller]
fn assert_transcript(sim: &SimSerial, expected: &str) {
    let actual = sim.transcript();
    let expected = expected.trim().lines().map(str::trim).collect::<Vec<_>>().join("\n");
    assert!(actual == expected, "transcript differs. Actual:\n{actual}\n\nExpected:\n{expected}");
}

/// The image is in the board's flash, and within a second the sketch runs:
/// the bootloader was told to leave ([`Exit::Left`]).
#[track_caller]
fn assert_flashed(sim: &SimSerial, image: &[u8]) {
    assert_flashed_and(sim, image, Exit::Left);
}

/// As [`assert_flashed`], for a bootloader that leaves in its own way.
#[track_caller]
fn assert_flashed_and(sim: &SimSerial, image: &[u8], left: Exit) {
    sim.board(|board| {
        assert_eq!(board.violations(), [] as [String; 0]);
        assert!(board.flash()[..image.len()] == *image, "the flash does not hold the image");
        board.sleep(1000);
        assert_eq!(board.exit(), Some(left), "the sketch is not running a second after the flash");
    });
}

#[track_caller]
fn assert_untouched(sim: &SimSerial) {
    sim.board(|board| assert_eq!(board.pages_written(), 0, "a failed flash must not program anything"));
}

// --- STK500v1 (Uno, Nano) ---------------------------------------------------

#[test]
fn uno_is_reset_synced_and_programmed_page_by_page() {
    let image = image(300);
    let sim = bridged(SimBootloader::optiboot(115_200), &image, 128);

    flash_image(&sim, BRIDGE_PORT, BoardType::Uno, &image).expect("flash");

    assert_flashed(&sim, &image);
    assert_transcript(
        &sim,
        "open /dev/cu.usbserial-110 @115200 timeout 1000ms
        dtr 0
        rts 0
        sleep 250
        dtr 1
        rts 1
        sleep 50
        sleep 50
        clear input
        tx 30 20
        flush
        rx 14 10
        tx 75 20
        flush
        rx 14 1E 95 0F 10
        clear input
        tx 50 20
        flush
        rx 14 10
        clear input
        tx 55 00 00 20
        flush
        rx 14 10
        clear input
        tx 64 00 80 46 image[0..128] 20
        flush
        rx 14 10
        clear input
        tx 55 40 00 20
        flush
        rx 14 10
        clear input
        tx 64 00 80 46 image[128..256] 20
        flush
        rx 14 10
        clear input
        tx 55 80 00 20
        flush
        rx 14 10
        clear input
        tx 64 00 2C 46 image[256..300] 20
        flush
        rx 14 10
        clear input
        tx 51 20
        flush
        rx 14 10
        close /dev/cu.usbserial-110",
    );
}

/// A CH340 Nano is guessed as the old 57600-baud bootloader; many run Optiboot
/// at 115200. The port is exclusive, so the fallback closes it before opening
/// it at the next baud, and resets the board again at that baud.
#[test]
fn nano_guess_falls_back_to_115200_by_closing_the_port_first() {
    let image = image(300);
    let sim = bridged(SimBootloader::optiboot(115_200), &image, 128);

    flash_image(&sim, BRIDGE_PORT, BoardType::Nano, &image).expect("flash");

    assert_flashed(&sim, &image);
    let transcript = sim.transcript();
    assert!(transcript.starts_with("open /dev/cu.usbserial-110 @57600 timeout 1000ms\n"), "{transcript}");
    let fallback = "rx timeout 550ms (wanted 2)
        close /dev/cu.usbserial-110
        sleep 100
        open /dev/cu.usbserial-110 @115200 timeout 1000ms
        dtr 0
        rts 0
        sleep 250
        dtr 1
        rts 1
        sleep 50
        sleep 50
        clear input
        tx 30 20
        flush
        rx 14 10";
    let fallback = fallback.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    assert!(transcript.contains(&fallback), "{transcript}");
}

/// The `nano` guess on the bootloader it is named for, `ATmegaBOOT` at 57600:
/// it ignores "leave programming mode" and starts the sketch on its own once
/// it has heard nothing for about 0.9 s.
#[test]
fn old_bootloader_nano_is_programmed_and_left_to_start_its_sketch() {
    let image = image(300);
    let sim = bridged(SimBootloader::atmegaboot(), &image, 128);

    flash_image(&sim, BRIDGE_PORT, BoardType::Nano, &image).expect("flash");

    assert_flashed_and(&sim, &image, Exit::TimedOut);
    let transcript = sim.transcript();
    assert!(transcript.ends_with("tx 51 20\nflush\nrx 14 10\nclose /dev/cu.usbserial-110"), "{transcript}");
}

/// The other wrong guess: tried at 115200, found at 57600 on the old bootloader.
#[test]
fn nano_new_guess_falls_back_to_the_old_bootloader_at_57600() {
    let image = image(300);
    let sim = bridged(SimBootloader::atmegaboot(), &image, 128);

    flash_image(&sim, BRIDGE_PORT, BoardType::NanoNew, &image).expect("flash");

    assert_flashed_and(&sim, &image, Exit::TimedOut);
}

/// Closing a port returns before some serial drivers have let go of it. The
/// fallback leaves the port alone for 100 ms, then tries the open a few times.
#[test]
fn baud_fallback_waits_for_a_port_that_is_still_busy_after_closing() {
    let image = image(300);
    let sim = bridged(SimBootloader::optiboot(115_200), &image, 128).busy_after_close(250);

    flash_image(&sim, BRIDGE_PORT, BoardType::Nano, &image).expect("flash");

    assert_flashed(&sim, &image);
    let reopen = "close /dev/cu.usbserial-110
        sleep 100
        open /dev/cu.usbserial-110 @115200 -> Resource busy
        sleep 100
        open /dev/cu.usbserial-110 @115200 -> Resource busy
        sleep 100
        open /dev/cu.usbserial-110 @115200 timeout 1000ms
        dtr 0";
    let reopen = reopen.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    assert!(sim.transcript().contains(&reopen), "{}", sim.transcript());
}

#[test]
fn baud_fallback_gives_up_on_a_port_that_stays_busy() {
    let image = image(300);
    let sim = bridged(SimBootloader::optiboot(115_200), &image, 128).busy_after_close(60_000);

    let error = flash_image(&sim, BRIDGE_PORT, BoardType::Nano, &image).expect_err("flash");

    assert_eq!(error.to_string(), "Failed to open port: Resource busy");
    assert_eq!(sim.transcript().matches("-> Resource busy").count(), 5);
    assert_untouched(&sim);
}

/// A board whose bootloader never answers is tried at every baud, then
/// reported as a failed sync, with nothing programmed. Eight syncs per baud
/// take 4.75 s (0.35 s of reset, eight 0.55 s waits), and each reopen 100 ms:
/// 14.45 s before the failure is reported.
#[test]
fn silent_board_is_tried_at_every_baud_and_fails_to_sync() {
    let image = image(300);
    let sim = bridged(SimBootloader::optiboot(9600), &image, 128);

    let error = flash_image(&sim, BRIDGE_PORT, BoardType::Uno, &image).expect_err("flash");

    assert_eq!(error.to_string(), "Failed to sync with bootloader");
    assert_untouched(&sim);
    assert_eq!(sim.elapsed_ms(), 3 * 4750 + 2 * 100);
    let opens: Vec<String> =
        sim.transcript().lines().filter(|l| l.starts_with("open ")).map(str::to_string).collect();
    assert_eq!(
        opens,
        [
            "open /dev/cu.usbserial-110 @115200 timeout 1000ms",
            "open /dev/cu.usbserial-110 @57600 timeout 1000ms",
            "open /dev/cu.usbserial-110 @19200 timeout 1000ms",
        ]
    );
}

/// A board that does not reset (no auto-reset capacitor) and whose sketch
/// keeps printing a couple of bytes, each pair just inside a wait: a
/// transact's wait is one deadline for the step, not a wait per read, so
/// the trickle buys no time. It fails at most one sync period per baud later
/// than a silent board (14.45 s), whatever it prints.
#[test]
fn a_talking_sketch_that_never_resets_fails_to_sync_about_as_soon_as_a_silent_board() {
    for (bytes, every_ms) in [(2, 540), (1, 500), (12, 50)] {
        let image = image(300);
        let boot = SimBootloader::optiboot(115_200).without_auto_reset().with_sketch_output(bytes, every_ms);
        let sim = bridged(boot, &image, 128);

        let error = flash_image(&sim, BRIDGE_PORT, BoardType::Uno, &image).expect_err("flash");

        assert_eq!(error.to_string(), "Failed to sync with bootloader");
        assert_untouched(&sim);
        let elapsed = sim.elapsed_ms();
        assert!(elapsed <= 3 * 4750 + 2 * 100 + 3 * 550, "{bytes} bytes every {every_ms} ms: failed after {elapsed} ms");
    }
}

/// Over a link that delivers every answer 300 ms late, Optiboot's answer to
/// the first sync (sent 100 ms after the reset edge, answered at 375 ms)
/// comes in after the second sync went out. The second sync does not discard
/// it, and the answer to the second sync, which comes in ahead of the
/// signature, is not taken for the signature's.
#[test]
fn uno_over_a_slow_link_keeps_the_answers_that_come_in_late() {
    let image = image(300);
    let sim = bridged(SimBootloader::optiboot(115_200).with_answer_delay_ms(300), &image, 128);

    flash_image(&sim, BRIDGE_PORT, BoardType::Uno, &image).expect("flash");

    assert_flashed(&sim, &image);
    let sync = "sleep 50
        clear input
        tx 30 20
        flush
        rx timeout 550ms (wanted 2)
        tx 30 20
        flush
        rx 14 10
        tx 75 20
        flush
        rx 14 10
        rx 14 1E 95
        rx 0F 10
        clear input
        tx 50 20";
    let sync = sync.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    assert!(sim.transcript().contains(&sync), "{}", sim.transcript());
}

#[test]
fn a_port_that_cannot_be_opened_is_reported_as_such() {
    let sim = bridged(SimBootloader::optiboot(115_200), &[], 128);

    let error = flash_image(&sim, "/dev/cu.nothing", BoardType::Uno, &image(300)).expect_err("flash");

    assert_eq!(error.to_string(), "Failed to open port: No such file or directory");
}

// --- STK500v2 (Mega) --------------------------------------------------------

#[test]
fn mega_is_reset_signed_on_and_programmed_page_by_page() {
    let image = image(600);
    let sim = bridged(SimBootloader::stk500boot(), &image, 256);

    flash_image(&sim, BRIDGE_PORT, BoardType::Mega, &image).expect("flash");

    assert_flashed(&sim, &image);
    assert_transcript(
        &sim,
        "open /dev/cu.usbserial-110 @115200 timeout 1000ms
        dtr 0
        rts 0
        sleep 250
        dtr 1
        rts 1
        sleep 50
        sleep 50
        clear input
        tx 1B 01 00 01 0E 01 14
        flush
        rx 1B 01 00 0B 0E 01 00 08 41 56 52 49 53 50 5F 32 74
        tx 1B 02 00 0C 0E 10 C8 64 19 20 00 53 03 AC 53 00 00 31
        flush
        rx 1B 02 00 02 0E 10 00 05
        clear input
        tx 1B 03 00 06 0E 1B 04 30 00 00 00 3F
        flush
        rx 1B 03 00 04 0E 1B 00 1E 00 17
        clear input
        tx 1B 04 00 06 0E 1B 04 30 00 01 00 39
        flush
        rx 1B 04 00 04 0E 1B 00 98 00 96
        clear input
        tx 1B 05 00 06 0E 1B 04 30 00 02 00 3B
        flush
        rx 1B 05 00 04 0E 1B 00 01 00 0E
        clear input
        tx 1B 06 00 05 0E 06 00 00 00 00 10
        flush
        rx 1B 06 00 02 0E 06 00 17
        clear input
        tx 1B 07 01 0A 0E 13 01 00 C1 0A 40 4C 20 00 00 image[0..256] 6C
        flush
        rx 1B 07 00 02 0E 13 00 03
        clear input
        tx 1B 08 00 05 0E 06 00 00 00 80 9E
        flush
        rx 1B 08 00 02 0E 06 00 19
        clear input
        tx 1B 09 01 0A 0E 13 01 00 C1 0A 40 4C 20 00 00 image[256..512] 62
        flush
        rx 1B 09 00 02 0E 13 00 0D
        clear input
        tx 1B 0A 00 05 0E 06 00 00 01 00 1D
        flush
        rx 1B 0A 00 02 0E 06 00 1B
        clear input
        tx 1B 0B 00 62 0E 13 00 58 C1 0A 40 4C 20 00 00 image[512..600] 10
        flush
        rx 1B 0B 00 02 0E 13 00 0F
        clear input
        tx 1B 0C 00 03 0E 11 01 01 0B
        flush
        rx 1B 0C 00 02 0E 11 00 0A
        close /dev/cu.usbserial-110",
    );
}

/// A USB-serial bridge hands an answer over in whatever pieces it forwarded.
#[test]
fn an_answer_that_arrives_in_pieces_is_put_together() {
    let image = image(600);
    let sim = bridged(SimBootloader::stk500boot(), &image, 256).reading_at_most(3);

    flash_image(&sim, BRIDGE_PORT, BoardType::Mega, &image).expect("flash");

    assert_flashed(&sim, &image);
    assert!(sim.transcript().contains("rx 1B 01 00\nrx 0B 0E 01\n"), "{}", sim.transcript());
}

/// Over a link that delivers every answer 300 ms late, the answer to the first
/// sign-on comes in after the second one went out. The second sign-on does
/// not discard it; "enter programming mode" goes out at once, and the answer
/// to the second sign-on, which comes in ahead of its own, is read past.
#[test]
fn mega_over_a_slow_link_keeps_the_answers_that_come_in_late() {
    let image = image(600);
    let sim = bridged(SimBootloader::stk500boot().with_answer_delay_ms(300), &image, 256);

    flash_image(&sim, BRIDGE_PORT, BoardType::Mega, &image).expect("flash");

    assert_flashed(&sim, &image);
    let sign_on = "sleep 50
        clear input
        tx 1B 01 00 01 0E 01 14
        flush
        rx timeout 250ms (wanted 17)
        tx 1B 01 00 01 0E 01 14
        flush
        rx 1B 01 00 0B 0E 01 00 08 41 56 52 49 53 50 5F 32 74
        tx 1B 02 00 0C 0E 10 C8 64 19 20 00 53 03 AC 53 00 00 31
        flush
        rx 1B 01 00 0B 0E 01 00 08
        rx 41 56 52 49 53 50 5F 32 74
        rx 1B 02 00 02 0E 10 00 05
        clear input
        tx 1B 03 00 06 0E 1B 04 30 00 00 00 3F";
    let sign_on = sign_on.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    assert!(sim.transcript().contains(&sign_on), "{}", sim.transcript());
}

/// A Mega that never answers is given up on 1.7 s after the port was opened:
/// 0.35 s of reset and five sign-ons 250 ms apart.
#[test]
fn silent_mega_fails_to_sync_after_five_sign_ons() {
    let image = image(600);
    // A chip that stays in reset hears nothing.
    let sim = bridged(SimBootloader::stk500boot().with_startup_ms(60_000), &image, 256);

    let error = flash_image(&sim, BRIDGE_PORT, BoardType::Mega, &image).expect_err("flash");

    assert_eq!(error.to_string(), "Failed to sync with bootloader");
    assert_untouched(&sim);
    assert_eq!(sim.transcript().matches("tx 1B 01 00 01 0E 01 14").count(), 5);
    assert_eq!(sim.transcript().matches("clear input").count(), 1, "only the first sign-on discards");
    assert_eq!(sim.elapsed_ms(), 350 + 5 * 250);
}

// --- AVR109 (Leonardo, Micro) -----------------------------------------------

#[test]
fn leonardo_is_touched_at_1200_baud_found_again_and_programmed() {
    let image = image(300);
    let sim = leonardo(SimBootloader::caterina(), LEONARDO_PORT, &image);

    flash_image(&sim, LEONARDO_PORT, BoardType::Leonardo, &image).expect("flash");

    assert_flashed(&sim, &image);
    assert_transcript(
        &sim,
        r#"open /dev/cu.usbmodem1101 @1200 timeout 1000ms
        dtr 0
        rts 0
        sleep 250
        close /dev/cu.usbmodem1101
        sleep 500
        sleep 100
        list ports -> []
        sleep 100
        list ports -> ["/dev/cu.usbmodem1101"]
        open /dev/cu.usbmodem1101 @57600 timeout 100ms
        close /dev/cu.usbmodem1101
        open /dev/cu.usbmodem1101 @57600 timeout 2000ms
        sleep 200
        clear input
        tx 53
        flush
        rx 43 41 54 45 52 49 4E
        tx 65
        flush
        rx 0D
        clear input
        tx 41 00 00
        flush
        rx 0D
        clear input
        tx 42 00 80 46 image[0..128]
        flush
        rx 0D
        clear input
        tx 42 00 80 46 image[128..256]
        flush
        rx 0D
        clear input
        tx 42 00 2C 46 image[256..300]
        flush
        rx 0D
        clear input
        tx 45
        flush
        sleep 100
        close /dev/cu.usbmodem1101"#,
    );
}

#[test]
fn leonardo_bootloader_is_found_on_another_port_name() {
    let image = image(300);
    let sim = leonardo(SimBootloader::caterina(), "/dev/cu.usbmodem1103", &image);

    flash_image(&sim, LEONARDO_PORT, BoardType::Leonardo, &image).expect("flash");

    assert_flashed(&sim, &image);
    assert!(sim.transcript().contains("open /dev/cu.usbmodem1103 @57600 timeout 2000ms"));
}

/// A chip erase rewrites 224 pages at up to 4.5 ms each and answers only when
/// it is done: just over two seconds on a slow chip.
#[test]
fn leonardo_flash_waits_out_a_two_second_chip_erase() {
    let image = image(300);
    let sim = leonardo(SimBootloader::caterina().with_erase_ms(2050), LEONARDO_PORT, &image);

    flash_image(&sim, LEONARDO_PORT, BoardType::Leonardo, &image).expect("flash");

    assert_flashed(&sim, &image);
}

#[test]
fn leonardo_whose_bootloader_never_appears_is_reported_not_found() {
    let image = image(300);
    let sim = SimSerial::native_usb(LEONARDO_PORT, LEONARDO_PORT, 60_000, SimBootloader::caterina());

    let error = flash_image(&sim, LEONARDO_PORT, BoardType::Leonardo, &image).expect_err("flash");

    assert_eq!(
        error.to_string(),
        "Board not found on Bootloader not found after reset (original port: /dev/cu.usbmodem1101) after reset"
    );
    assert_untouched(&sim);
    // The touch, then 0.5 s and thirty looks 100 ms apart.
    assert_eq!(sim.elapsed_ms(), 250 + 500 + 30 * 100);
}

// --- The firmware that ships ------------------------------------------------

/// The embedded `StandardFirmata` of every supported board, whole, each on
/// the bootloader that board ships with: about 115 pages on an Uno, so
/// addresses and lengths go well past one byte.
#[test]
fn standard_firmata_lands_whole_on_every_board() {
    for board in BoardType::all() {
        let image = hex::parse(firmware::standard_firmata_hex(board)).expect("embedded hex");
        let sim = match board {
            BoardType::Uno | BoardType::NanoNew => SimSerial::bridged(BRIDGE_PORT, SimBootloader::optiboot(115_200)),
            BoardType::Nano => SimSerial::bridged(BRIDGE_PORT, SimBootloader::atmegaboot()),
            BoardType::Mega => SimSerial::bridged(BRIDGE_PORT, SimBootloader::stk500boot()),
            BoardType::Leonardo | BoardType::Micro => {
                SimSerial::native_usb(LEONARDO_PORT, LEONARDO_PORT, 900, SimBootloader::caterina())
            }
        };
        let port = if sim.is_native_usb() { LEONARDO_PORT } else { BRIDGE_PORT };

        flash_image(&sim, port, board, &image).unwrap_or_else(|e| panic!("{board:?}: {e}"));

        // The old Nano bootloader ignores "leave" and idles out into the sketch.
        let left = if board == BoardType::Nano { Exit::TimedOut } else { Exit::Left };
        assert_flashed_and(&sim, &image, left);
    }
}
