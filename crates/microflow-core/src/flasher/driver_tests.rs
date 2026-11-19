//! The bootloader drivers against modelled bootloaders.
//!
//! [`flash`] is a minimal executor: it runs a board's [`FlashDriver`] step by
//! step against a [`SimBootloader`], the way the browser and desktop executors
//! run it against a serial port. A test asserts on the chip afterwards: what
//! is in its flash, and how the bootloader was left.
//!
//! Where a decision shows only in the steps (a pause, a retry, when to give
//! up), a test drives the driver by hand through `start` and `advance`.

use super::sim::{Exit, SimBootloader};
use super::*;

/// A flash image of `len` bytes in which every page is different.
fn image(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 7 + i / 128 + 3) as u8).collect()
}

/// How long the host is between two steps: it acts on what a read brought
/// some time after the read ended (the browser looks at its input every
/// 10 ms; a busy machine takes longer). What comes in meanwhile sits in the
/// input when the next step starts, as on a real port.
const HOST_TURNAROUND_MS: u32 = 10;

/// Flash `image` as `board` onto the chip behind `sim`; returns the driver's
/// last step ([`FlashStep::Done`] or [`FlashStep::Error`]).
fn flash(board: BoardType, image: &[u8], sim: &mut SimBootloader) -> FlashStep {
    flash_logged(board, image, sim).0
}

/// As [`flash`], with every write and when it went out, on the sim's clock.
fn flash_logged(board: BoardType, image: &[u8], sim: &mut SimBootloader) -> (FlashStep, Vec<(u64, Vec<u8>)>) {
    let config = BoardConfig::find(board);
    let native_usb = config.protocol == Protocol::Avr109;
    let mut driver = new_driver(board, image.to_vec());
    sim.set_baud(config.baud_rate);
    if !native_usb {
        sim.reset(); // Opening the port asserts DTR, which resets the board.
    }
    let mut dtr = true;
    let mut writes = Vec::new();
    let mut step = driver.start();
    for _ in 0..100_000 {
        let mut input = Vec::new();
        match &step {
            FlashStep::Done | FlashStep::Error { .. } => return (step, writes),
            FlashStep::Reset { dtr: level, delay_ms, .. } => {
                if !native_usb && *level && !dtr {
                    sim.reset();
                }
                dtr = *level;
                sim.sleep(*delay_ms);
            }
            FlashStep::SetBaud { baud } => {
                sim.set_baud(*baud);
                if !native_usb {
                    sim.reset(); // The reopen asserts DTR again.
                }
                dtr = true;
            }
            FlashStep::FlushInput => sim.discard_input(),
            FlashStep::Transact { write, read_len, timeout_ms, keep_input } => {
                sim.sleep(HOST_TURNAROUND_MS);
                if !keep_input {
                    sim.discard_input();
                }
                if !write.is_empty() {
                    writes.push((sim.now_ms(), write.clone()));
                    sim.write(write);
                }
                // One deadline for the whole step, however many reads it takes.
                let deadline = sim.now_ms() + u64::from(*timeout_ms);
                while input.len() < *read_len {
                    let left = deadline.saturating_sub(sim.now_ms());
                    let chunk = if left == 0 { Vec::new() } else { sim.read(*read_len - input.len(), left as u32) };
                    if chunk.is_empty() {
                        break;
                    }
                    input.extend(chunk);
                }
            }
            FlashStep::Delay { ms } => sim.sleep(*ms),
            FlashStep::ReacquirePort { wait_ms, baud } => {
                // The touched board comes back as its bootloader.
                sim.sleep(*wait_ms);
                sim.reset();
                sim.set_baud(*baud);
            }
            FlashStep::Progress { .. } => {}
        }
        step = driver.advance(&input);
    }
    panic!("the driver did not terminate");
}

/// The image is in the chip's flash, and within a second the sketch runs:
/// the bootloader was told to leave ([`Exit::Left`]).
#[track_caller]
fn assert_flashed(sim: &mut SimBootloader, image: &[u8]) {
    assert_flashed_and(sim, image, Exit::Left);
}

/// As [`assert_flashed`], for a bootloader that leaves in its own way.
#[track_caller]
fn assert_flashed_and(sim: &mut SimBootloader, image: &[u8], left: Exit) {
    assert_eq!(sim.violations(), [] as [String; 0]);
    assert!(sim.flash()[..image.len()] == *image, "the flash does not hold the image");
    sim.sleep(1000);
    assert_eq!(sim.exit(), Some(left), "the sketch is not running a second after the flash");
}

/// Flash `board` onto a board whose reset line is not wired, so it never
/// leaves its sketch, and whose sketch prints `bytes` bytes every `every_ms`
/// (none when 0). The flash must fail as a failed sync with nothing
/// programmed; returns how long that took, in ms.
fn time_to_fail_on_a_board_that_never_resets(board: BoardType, bytes: usize, every_ms: u32) -> u64 {
    let boot = match BoardConfig::find(board).protocol {
        Protocol::Stk500v1 => SimBootloader::optiboot(115_200),
        Protocol::Stk500v2 => SimBootloader::stk500boot(),
        Protocol::Avr109 => SimBootloader::caterina(),
    };
    let mut sim = boot.without_auto_reset();
    if bytes > 0 {
        sim = sim.with_sketch_output(bytes, every_ms);
    }
    let end = flash(board, &image(300), &mut sim);
    assert_eq!(end, FlashStep::Error { error: FlashError::SyncFailed }, "{bytes} bytes every {every_ms} ms");
    assert_eq!(sim.pages_written(), 0);
    sim.now_ms()
}

/// A board that never enters its bootloader is given up on in about the time
/// a silent one is, whatever its sketch prints and however it trickles in:
/// what the sketch prints can keep the driver listening for at most one more
/// wait per baud rate (`allowance_ms` in all).
#[track_caller]
fn assert_a_talking_sketch_costs_at_most(board: BoardType, allowance_ms: u64, talk: &[(usize, u32)]) {
    let silent = time_to_fail_on_a_board_that_never_resets(board, 0, 0);
    for &(bytes, every_ms) in talk {
        let talking = time_to_fail_on_a_board_that_never_resets(board, bytes, every_ms);
        assert!(
            talking <= silent + allowance_ms,
            "{board:?} printing {bytes} bytes every {every_ms} ms failed after {talking} ms; a silent one after {silent} ms"
        );
    }
}

/// When each command of a kind goes out, in ms after the reset edge (DTR
/// asserted), on a board that never answers, and when the driver gives up on
/// it (after the last reset edge). `None` ends the run.
fn silent_schedule(board: BoardType, mut is_one: impl FnMut(&[u8]) -> Option<bool>) -> (Vec<u32>, u32) {
    let mut driver = new_driver(board, image(8));
    let mut step = driver.start();
    let (mut clock, mut sent_at) = (0, Vec::new());
    for _ in 0..1000 {
        match &step {
            FlashStep::Reset { dtr, delay_ms, .. } => {
                if *dtr {
                    clock = 0;
                }
                clock += delay_ms;
            }
            FlashStep::Delay { ms } => clock += ms,
            FlashStep::Transact { write, timeout_ms, .. } => {
                match is_one(write) {
                    Some(true) => sent_at.push(clock),
                    Some(false) => {}
                    None => return (sent_at, clock),
                }
                clock += timeout_ms;
            }
            FlashStep::Done | FlashStep::Error { .. } => return (sent_at, clock),
            _ => {}
        }
        step = driver.advance(&[]);
    }
    panic!("the driver did not terminate");
}

/// The transacts of a flash of `board` in which the board answers each one
/// with what `answer` returns for it (the bytes it writes, the number of bytes
/// it asks for), up to the `limit`th, and the step the flash ended with if it
/// ended before.
fn transacts(
    board: BoardType,
    limit: usize,
    mut answer: impl FnMut(&[u8], usize) -> Vec<u8>,
) -> Vec<FlashStep> {
    let mut driver = new_driver(board, image(8));
    let mut step = driver.start();
    let mut seen = Vec::new();
    for _ in 0..1000 {
        step = match &step {
            FlashStep::Done | FlashStep::Error { .. } => {
                seen.push(step);
                return seen;
            }
            FlashStep::Transact { write, read_len, .. } => {
                let input = answer(write, *read_len);
                seen.push(step.clone());
                if seen.len() == limit {
                    return seen;
                }
                driver.advance(&input)
            }
            _ => driver.advance(&[]),
        };
    }
    panic!("the driver did not terminate");
}

/// Whether each transact among `steps` keeps its input.
fn kept_input(steps: &[FlashStep]) -> Vec<bool> {
    steps
        .iter()
        .filter_map(|step| match step {
            FlashStep::Transact { keep_input, .. } => Some(*keep_input),
            _ => None,
        })
        .collect()
}

/// Step `driver` from `step` to its next [`FlashStep::Transact`], answering
/// nothing on the way; returns the bytes that transact writes.
fn next_command(driver: &mut dyn FlashDriver, mut step: FlashStep) -> Vec<u8> {
    for _ in 0..20 {
        if let FlashStep::Transact { write, .. } = step {
            return write;
        }
        step = driver.advance(&[]);
    }
    panic!("the driver sent no command");
}

/// Run `driver` to its end, answering each command with what `answer` returns
/// for the bytes written.
fn run(driver: &mut dyn FlashDriver, mut answer: impl FnMut(&[u8]) -> Vec<u8>) -> FlashStep {
    let mut step = driver.start();
    for _ in 0..10_000 {
        step = match &step {
            FlashStep::Done | FlashStep::Error { .. } => return step,
            FlashStep::Transact { write, .. } => driver.advance(&answer(write)),
            _ => driver.advance(&[]),
        };
    }
    panic!("the driver did not terminate");
}

// --- STK500v1 (Uno, Nano) ---------------------------------------------------

const SYNC: [u8; 2] = [0x30, 0x20];
const READ_SIGNATURE: [u8; 2] = [0x75, 0x20];
const IN_SYNC_OK: [u8; 2] = [0x14, 0x10];
const SIGNATURE_OK: [u8; 5] = [0x14, 0x1E, 0x95, 0x0F, 0x10];

#[test]
fn uno_image_lands_in_the_bootloaders_flash() {
    let image = image(300);
    let mut sim = SimBootloader::optiboot(115_200);

    assert_eq!(flash(BoardType::Uno, &image, &mut sim), FlashStep::Done);

    assert_flashed(&mut sim, &image);
    assert_eq!(sim.pages_written(), 3, "one flash page per 128 bytes");
}

/// A CH340 Nano is guessed as the old-bootloader `nano` (57600). Many ship
/// with Optiboot at 115200: the sync must fall back and the flash succeed.
#[test]
fn nano_guess_flashes_an_optiboot_nano_at_115200() {
    assert_eq!(BoardConfig::find(BoardType::Nano).baud_rate, 57600);
    let image = image(300);
    let mut sim = SimBootloader::optiboot(115_200);

    assert_eq!(flash(BoardType::Nano, &image, &mut sim), FlashStep::Done);

    assert_flashed(&mut sim, &image);
}

/// The `nano` guess meets the bootloader it is named for: `ATmegaBOOT` at
/// 57600. It syncs after one LED flash, reports the 328P, and takes every
/// page. It ignores "leave programming mode", so the sketch starts when the
/// bootloader has heard nothing for about 0.9 s.
#[test]
fn nano_image_lands_in_the_old_bootloaders_flash() {
    let image = image(300);
    let mut sim = SimBootloader::atmegaboot();

    assert_eq!(flash(BoardType::Nano, &image, &mut sim), FlashStep::Done);

    assert!(sim.in_bootloader(), "ATmegaBOOT stays after 'leave programming mode'");
    assert_flashed_and(&mut sim, &image, Exit::TimedOut);
    assert_eq!(sim.pages_written(), 3, "one flash page per 128 bytes");
}

/// The reverse guess: a board tried at 115200 that runs the old 57600
/// bootloader. The syncs at the wrong rate reach `ATmegaBOOT` as errors, which
/// it counts; five send it to the sketch. The reset at 57600 brings it back.
#[test]
fn nano_new_guess_flashes_an_old_bootloader_nano_at_57600() {
    let image = image(300);
    let mut sim = SimBootloader::atmegaboot();

    assert_eq!(flash(BoardType::NanoNew, &image, &mut sim), FlashStep::Done);

    assert_flashed_and(&mut sim, &image, Exit::TimedOut);
}

/// The stock Optiboot hears its first byte only within about 1.45 s of the
/// reset edge and `ATmegaBOOT` within about 1.15 s: the first three syncs are
/// for them. The other five are for bootloaders that listen longer and boards
/// that reset late. A sync waits 500 ms for its answer because Optiboot's
/// first one takes 350 ms.
#[test]
fn eight_syncs_go_out_per_baud_550_ms_apart() {
    let (syncs, gave_up) = silent_schedule(BoardType::Uno, |write| (write == SYNC).then_some(true));
    let per_baud = [100, 650, 1200, 1750, 2300, 2850, 3400, 3950];
    // Three bauds; the reset before each restarts the count.
    assert_eq!(syncs, [per_baud, per_baud, per_baud].concat());
    assert_eq!(gave_up, 4500, "the last sync is waited for as long as the others");
}

/// A bootloader at a rate no fallback tries: every baud is exhausted, the
/// flash fails as a sync failure, and nothing is programmed.
#[test]
fn silent_bootloader_fails_after_every_baud() {
    let mut sim = SimBootloader::optiboot(9600);

    let end = flash(BoardType::Nano, &image(300), &mut sim);

    assert_eq!(end, FlashStep::Error { error: FlashError::SyncFailed });
    assert_eq!(sim.pages_written(), 0);
}

/// The guessed baud is tried first: a board that answers at it never sees a
/// baud switch.
#[test]
fn a_board_at_the_guessed_baud_is_never_switched() {
    let mut driver = new_driver(BoardType::Nano, image(8));
    let mut step = driver.start();
    for _ in 0..100 {
        step = match &step {
            FlashStep::Done => return,
            FlashStep::SetBaud { baud } => panic!("switched to {baud} baud"),
            FlashStep::Transact { write, .. } if write == &READ_SIGNATURE => driver.advance(&SIGNATURE_OK),
            FlashStep::Transact { .. } => driver.advance(&IN_SYNC_OK),
            other @ FlashStep::Error { .. } => panic!("{other:?}"),
            _ => driver.advance(&[]),
        };
    }
    panic!("the driver did not terminate");
}

/// The sim's clock when [`flash`] pulls DTR up after its first 250 ms low:
/// the reset edge the bootloader's windows count from.
const RESET_EDGE_MS: u64 = 250;

/// When the first write that starts with `command` went out.
#[track_caller]
fn sent_at(writes: &[(u64, Vec<u8>)], command: &[u8]) -> u64 {
    writes.iter().find(|(_, write)| write.starts_with(command)).map(|&(at, _)| at).expect("never sent")
}

/// A link that takes its time (a slow USB-serial bridge, a hub, a busy
/// machine), by any delay up to what the commands after the sync allow: the
/// answer to a sync comes in after the next sync went out, or while the host
/// was between two syncs, and the answers to the repeated syncs after the
/// signature read did. The first answer ends the sync as soon as it is in the
/// input: the signature read goes out at most two host turnarounds after it
/// came in, not one sync later. Each `INSYNC OK` after it is taken for what it
/// is, and the flash goes through.
#[test]
fn uno_whose_answers_come_late_is_synced_on_the_first_answer_and_programmed() {
    // Optiboot answers the first sync when its LED flashes are over.
    sync_on_the_first_late_answer(BoardType::Uno, || SimBootloader::optiboot(115_200), 375, 100..=450);
}

/// The same on the old bootloader, which answers its first sync sooner and
/// starts the sketch on its own.
#[test]
fn old_bootloader_nano_whose_answers_come_late_is_synced_on_the_first_answer_and_programmed() {
    sync_on_the_first_late_answer(BoardType::Nano, SimBootloader::atmegaboot, 200, 300..=480);
}

/// Flash `board` over links `delays` ms slow, in 10 ms steps, onto a
/// bootloader that answers its first sync `first_answer_ms` after the reset
/// edge; the signature read must follow the first answer.
#[track_caller]
fn sync_on_the_first_late_answer(
    board: BoardType,
    boot: impl Fn() -> SimBootloader,
    first_answer_ms: u64,
    delays: std::ops::RangeInclusive<u32>,
) {
    for delay in delays.step_by(10) {
        let image = image(300);
        let mut sim = boot().with_answer_delay_ms(delay);

        let (end, writes) = flash_logged(board, &image, &mut sim);

        assert_eq!(end, FlashStep::Done, "answers {delay} ms late");
        let left = if board == BoardType::Uno { Exit::Left } else { Exit::TimedOut };
        assert_flashed_and(&mut sim, &image, left);
        let answered = RESET_EDGE_MS + first_answer_ms + u64::from(delay);
        let signature_read = sent_at(&writes, &READ_SIGNATURE);
        assert!(
            signature_read <= answered + 2 * u64::from(HOST_TURNAROUND_MS),
            "answers {delay} ms late: the first came in at {answered} ms, the signature read went out at {signature_read} ms"
        );
    }
}

/// Only the first sync after a reset discards the input. A repeated sync and
/// the signature read keep it, so an answer that was on its way is read, not
/// thrown away; every command after the signature discards again. A
/// repeated sync that discarded shows in the late-answer flashes above; a
/// signature read that discarded would only lose answers to syncs, which the
/// driver reads past anyway, so here it shows only in the flags.
#[test]
fn nothing_is_discarded_from_the_first_sync_to_the_signature_answer() {
    let mut syncs = 0;
    let steps = transacts(BoardType::Uno, 5, |write, _| match write[0] {
        0x30 => {
            syncs += 1;
            if syncs == 3 { IN_SYNC_OK.to_vec() } else { Vec::new() }
        }
        0x75 => SIGNATURE_OK.to_vec(),
        _ => IN_SYNC_OK.to_vec(),
    });

    // Three syncs, the signature read, "enter programming mode".
    assert_eq!(kept_input(&steps), [false, true, true, true, false]);
}

/// The answers to two repeated syncs come in ahead of the signature: they are
/// read past, and the signature after them is the one checked.
#[test]
fn late_sync_answers_ahead_of_the_signature_are_read_past() {
    let mut syncs = 0;
    let mut asked = Vec::new();
    let steps = transacts(BoardType::Uno, 6, |write, read_len| {
        asked.push((write.first().copied(), read_len));
        match write.first() {
            Some(0x30) => {
                syncs += 1;
                if syncs == 3 { IN_SYNC_OK.to_vec() } else { Vec::new() }
            }
            // Two late sync answers and the first byte of the signature's.
            Some(0x75) => vec![0x14, 0x10, 0x14, 0x10, 0x14],
            None => vec![0x1E, 0x95, 0x0F, 0x10],
            _ => IN_SYNC_OK.to_vec(),
        }
    });

    assert_eq!(
        asked,
        [(Some(0x30), 2), (Some(0x30), 2), (Some(0x30), 2), (Some(0x75), 5), (None, 4), (Some(0x50), 2)]
    );
    assert!(matches!(steps.last(), Some(FlashStep::Transact { keep_input: false, .. })));
}

/// No more sync answers are read past than syncs were repeated: a board that
/// answers the signature read with `INSYNC OK` where none can be late has not
/// reported a signature.
#[test]
fn a_sync_answer_in_place_of_the_signature_stops_the_flash() {
    let mut driver = new_driver(BoardType::Uno, image(8));
    let mut sent = Vec::new();
    let end = run(driver.as_mut(), |write| {
        sent.push(write[0]);
        if write == READ_SIGNATURE { vec![0x14, 0x10, 0x14, 0x10, 0x14] } else { IN_SYNC_OK.to_vec() }
    });

    assert_eq!(end, FlashStep::Error { error: FlashError::Communication("Signature read not OK".into()) });
    assert_eq!(sent, [0x30, 0x75], "nothing may follow the signature read");
}

/// Bytes that are no sync answer do not end an attempt: the driver listens on
/// for the rest of the period, and the answer behind them is found. The first
/// half of an answer is kept until its second half comes in.
#[test]
fn a_sync_answer_behind_noise_is_found() {
    let mut reads = 0;
    let steps = transacts(BoardType::Uno, 3, |_, _| {
        reads += 1;
        match reads {
            1 => vec![0x00, 0x14],
            _ => vec![0x10],
        }
    });

    assert_eq!(
        steps[1],
        FlashStep::Transact { write: vec![], read_len: 64 + 1, timeout_ms: 550, keep_input: true },
        "after the noise, the driver waits out the period without sending: for the second half, and \
         for as many bytes as it reads past"
    );
    assert!(matches!(&steps[2], FlashStep::Transact { write, .. } if write == &READ_SIGNATURE));
}

/// A board that only ever sends noise (its sketch is running, or it talks at
/// another rate) does not keep the driver listening for ever.
#[test]
fn endless_noise_fails_the_sync() {
    let mut driver = new_driver(BoardType::Uno, image(8));
    let mut reads = 0;
    let end = run(driver.as_mut(), |_| {
        reads += 1;
        vec![0xF9, 0x02]
    });

    assert_eq!(end, FlashStep::Error { error: FlashError::SyncFailed });
    assert!(reads < 2000, "{reads} reads");
}

/// A sketch that keeps printing (the board does not reset into its
/// bootloader) is given up on at most one sync wait per baud rate later than
/// a silent board: three bauds of eight waits silent, of nine at most
/// talking. Each byte it prints does not buy another wait.
#[test]
fn a_talking_sketch_that_never_resets_fails_the_sync_about_as_soon_as_a_silent_one() {
    assert_a_talking_sketch_costs_at_most(
        BoardType::Uno,
        3 * u64::from(550 + HOST_TURNAROUND_MS),
        &[(2, 540), (6, 500), (1, 549), (1, 270), (10, 100), (12, 50), (200, 50)],
    );
}

#[test]
fn a_malformed_signature_reply_stops_the_flash_before_anything_is_programmed() {
    let malformed: [&[u8]; 4] =
        [&[], &[0x14, 0x1E, 0x95], &[0x00, 0x1E, 0x95, 0x0F, 0x10], &[0x14, 0x1E, 0x95, 0x0F, 0x00]];
    for reply in malformed {
        let mut driver = new_driver(BoardType::Uno, image(8));
        let mut sent = Vec::new();
        let end = run(driver.as_mut(), |write| {
            sent.push(write[0]);
            if write == READ_SIGNATURE { reply.to_vec() } else { IN_SYNC_OK.to_vec() }
        });

        assert!(
            matches!(end, FlashStep::Error { error: FlashError::Communication(_) }),
            "signature reply {reply:02X?} gave {end:?}"
        );
        assert_eq!(sent, [0x30, 0x75], "nothing may follow the signature read");
    }
}

/// The signature's value is not checked: clones report other chips.
#[test]
fn an_unexpected_signature_value_is_tolerated() {
    let mut driver = new_driver(BoardType::Uno, image(8));
    let end = run(driver.as_mut(), |write| {
        if write == READ_SIGNATURE { vec![0x14, 0x1E, 0x94, 0x0B, 0x10] } else { IN_SYNC_OK.to_vec() }
    });
    assert_eq!(end, FlashStep::Done);
}

/// Every page was acknowledged by then, and the host probes the board after a
/// flash, so a lost answer to "leave programming mode" is not a failed flash.
#[test]
fn a_missing_leave_acknowledgement_does_not_fail_a_programmed_flash() {
    let mut driver = new_driver(BoardType::Uno, image(8));
    let end = run(driver.as_mut(), |write| match write[0] {
        0x75 => SIGNATURE_OK.to_vec(),
        0x51 => Vec::new(),
        _ => IN_SYNC_OK.to_vec(),
    });
    assert_eq!(end, FlashStep::Done);
}

#[test]
fn an_unacknowledged_page_fails_the_flash() {
    let mut driver = new_driver(BoardType::Uno, image(300));
    let mut pages = 0;
    let end = run(driver.as_mut(), |write| match write[0] {
        0x75 => SIGNATURE_OK.to_vec(),
        0x64 => {
            pages += 1;
            if pages == 2 { vec![0x14, 0x11] } else { IN_SYNC_OK.to_vec() }
        }
        _ => IN_SYNC_OK.to_vec(),
    });
    assert_eq!(
        end,
        FlashStep::Error { error: FlashError::ProgramFailed("page 1 was not acknowledged".into()) }
    );
}

// --- STK500v2 (Mega) --------------------------------------------------------

#[test]
fn mega_image_lands_in_the_bootloaders_flash() {
    let image = image(600);
    let mut sim = SimBootloader::stk500boot();

    assert_eq!(flash(BoardType::Mega, &image, &mut sim), FlashStep::Done);

    assert_flashed(&mut sim, &image);
    assert_eq!(sim.pages_written(), 3, "one flash page per 256 bytes");
}

/// `stk500boot` listens about a second for a first byte, counted from when
/// the chip comes out of reset, then starts the sketch. Here the chip is slow
/// out of reset and the first sign-on, 100 ms after the reset edge, is lost:
/// a retry has to arrive while the bootloader still listens.
#[test]
fn mega_whose_first_sign_on_is_lost_is_signed_on_by_a_retry() {
    let image = image(600);
    let mut sim = SimBootloader::stk500boot().with_startup_ms(150);

    assert_eq!(flash(BoardType::Mega, &image, &mut sim), FlashStep::Done);

    assert_flashed(&mut sim, &image);
}

/// Five sign-ons, four of them while the bootloader listens (to somewhere
/// between 0.9 and 1.1 s after the edge). The driver gives up 250 ms after
/// the last one.
#[test]
fn mega_sign_ons_go_out_250_ms_apart_four_of_them_in_the_bootloaders_first_second() {
    let (sign_ons, gave_up) = silent_schedule(BoardType::Mega, |write| Some(write[5] == 0x01));
    assert_eq!(sign_ons, [100, 350, 600, 850, 1100]);
    assert_eq!(gave_up, 1350);
}

/// The same on a Mega: a talking sketch costs at most one more sign-on wait.
#[test]
fn a_talking_mega_sketch_that_never_resets_fails_the_sign_on_about_as_soon_as_a_silent_one() {
    assert_a_talking_sketch_costs_at_most(
        BoardType::Mega,
        u64::from(250 + HOST_TURNAROUND_MS),
        &[(6, 200), (1, 249), (16, 240), (17, 240), (30, 100), (12, 50), (200, 50)],
    );
}

/// A link that takes its time (a slow USB-serial bridge, a hub, a busy
/// machine, Web Serial): the answer to a sign-on comes in after the next
/// sign-on went out, and the answers to the repeated ones after "enter
/// programming mode" did. The first answer ends the sign-on as soon as it is
/// in the input, also when it came in while the host was between two
/// sign-ons: "enter programming mode" goes out at most two host turnarounds
/// after it. The other answers are read past by their sequence number, and
/// the flash goes through, whatever the link's delay.
#[test]
fn mega_whose_answers_come_late_is_signed_on_by_the_first_answer_and_programmed() {
    for delay in (150..=700).step_by(10) {
        let image = image(600);
        let mut sim = SimBootloader::stk500boot().with_answer_delay_ms(delay);

        let (end, writes) = flash_logged(BoardType::Mega, &image, &mut sim);

        assert_eq!(end, FlashStep::Done, "answers {delay} ms late");
        assert_flashed(&mut sim, &image);
        assert_eq!(sim.pages_written(), 3);
        // The first sign-on is heard as it goes out: 100 ms after the edge
        // and one host turnaround.
        let answered = RESET_EDGE_MS + 100 + u64::from(HOST_TURNAROUND_MS + delay);
        let enter_progmode = sent_at(&writes, &[0x1B, 0x02, 0x00, 0x0C, 0x0E, 0x10]);
        assert!(
            enter_progmode <= answered + 2 * u64::from(HOST_TURNAROUND_MS),
            "answers {delay} ms late: the first came in at {answered} ms, enter programming mode went out at {enter_progmode} ms"
        );
    }
}

/// Both at once: the chip is slow out of reset, so the first sign-on is lost,
/// and the link is slow, so the answer to the second comes in after the third
/// went out.
#[test]
fn mega_whose_first_sign_on_is_lost_and_whose_answers_come_late_is_programmed() {
    for delay in [220, 300, 450] {
        let image = image(600);
        let mut sim = SimBootloader::stk500boot().with_startup_ms(150).with_answer_delay_ms(delay);

        assert_eq!(flash(BoardType::Mega, &image, &mut sim), FlashStep::Done, "answers {delay} ms late");

        assert_flashed(&mut sim, &image);
    }
}

/// Frame `body` as the bootloader's answer to message `seq`.
fn v2_answer(seq: u8, body: &[u8]) -> Vec<u8> {
    let mut answer = vec![0x1B, seq, (body.len() >> 8) as u8, body.len() as u8, 0x0E];
    answer.extend_from_slice(body);
    answer.push(answer.iter().fold(0, |acc, &b| acc ^ b));
    answer
}

/// The body of the bootloader's answer to a sign-on.
const SIGNED_ON: &[u8] = b"\x01\x00\x08AVRISP_2";

/// Only the first sign-on discards the input. A repeated sign-on and "enter
/// programming mode" keep it, so an answer that was on its way is read, not
/// thrown away; every command after that discards again. A repeated sign-on
/// that discarded shows in the late-answer flashes above; "enter programming
/// mode" that discarded would only lose answers to sign-ons, which the driver
/// reads past anyway, so here it shows only in the flags.
#[test]
fn nothing_is_discarded_from_the_first_sign_on_to_the_answer_to_enter_progmode() {
    let mut sign_ons = 0;
    let steps = transacts(BoardType::Mega, 5, |write, _| match write[5] {
        0x01 => {
            sign_ons += 1;
            if sign_ons == 3 { v2_answer(1, SIGNED_ON) } else { Vec::new() }
        }
        command => v2_answer(write[1], &[command, 0x00, 0x1E, 0x00]),
    });

    // Three sign-ons, "enter programming mode", the first signature byte.
    assert_eq!(kept_input(&steps), [false, true, true, true, false]);
}

/// The answer to an earlier sign-on is what "enter programming mode" reads
/// first. It is not that command's answer (it carries sequence number 1, the
/// command 2), and it is not a failure either: the driver reads past it, to
/// the answer that carries the command's number.
#[test]
fn a_late_sign_on_answer_is_never_taken_for_the_answer_to_the_next_command() {
    let late = v2_answer(1, SIGNED_ON);
    let mut reads = 0;
    let mut asked = Vec::new();
    let steps = transacts(BoardType::Mega, 5, |write, read_len| {
        reads += 1;
        asked.push((write.get(5).copied(), read_len));
        match reads {
            1 => Vec::new(),         // the first sign-on: nothing in time
            2 => late.clone(),       // its answer, after the second went out
            3 => late[..8].to_vec(), // the second one's answer, in two pieces
            4 => [&late[8..], &v2_answer(2, &[0x10, 0x00])[..]].concat(),
            _ => Vec::new(),
        }
    });

    assert_eq!(
        asked,
        [
            (Some(0x01), 17),
            (Some(0x01), 17),
            (Some(0x10), 8),
            // The rest of the late answer, then the 8 bytes of its own.
            (None, 9 + 8),
            (Some(0x1B), 10),
        ],
        "{steps:?}"
    );
}

/// A sign-on answer cut in two by the end of one wait is put together in the
/// next: the bytes that came in are kept, and only the missing ones asked for.
#[test]
fn a_sign_on_answer_that_straddles_two_waits_is_put_together() {
    let answer = v2_answer(1, SIGNED_ON);
    let mut reads = 0;
    let mut asked = Vec::new();
    transacts(BoardType::Mega, 3, |write, read_len| {
        reads += 1;
        asked.push((write.get(5).copied(), read_len));
        match reads {
            1 => answer[..5].to_vec(),
            _ => answer[5..].to_vec(),
        }
    });

    assert_eq!(asked, [(Some(0x01), 17), (Some(0x01), 12), (Some(0x10), 8)]);
}

/// Bytes that frame no message are read past, and so is a message whose
/// checksum is wrong; the answer behind them is found.
#[test]
fn a_sign_on_answer_behind_noise_is_found() {
    let mut damaged = v2_answer(1, SIGNED_ON);
    damaged[9] ^= 0xFF;
    let input = [&[0xF9, 0x02, 0x1B][..], &damaged, &v2_answer(1, SIGNED_ON)].concat();
    let mut at = 0;
    let steps = transacts(BoardType::Mega, 10, |write, read_len| {
        if write.get(5).is_some_and(|&command| command != 0x01) {
            return Vec::new();
        }
        let chunk = input[at..(at + read_len).min(input.len())].to_vec();
        at += chunk.len();
        chunk
    });

    let commands: Vec<u8> = steps
        .iter()
        .filter_map(|step| match step {
            FlashStep::Transact { write, .. } => write.get(5).copied(),
            _ => None,
        })
        .collect();
    assert_eq!(commands, [0x01, 0x10], "one sign-on, then enter programming mode: {steps:?}");
    assert_eq!(at, input.len(), "every byte was read");
}

#[test]
fn mega_sign_on_carries_the_checksum_and_sequence_the_bootloader_expects() {
    let mut driver = new_driver(BoardType::Mega, image(8));
    let start = driver.start();
    // MESSAGE_START, sequence 1, size 1, TOKEN, CMD_SIGN_ON, XOR of all of them.
    assert_eq!(next_command(driver.as_mut(), start), [0x1B, 0x01, 0x00, 0x01, 0x0E, 0x01, 0x14]);
}

#[test]
fn mega_that_rejects_the_sign_on_is_never_programmed() {
    let mut driver = new_driver(BoardType::Mega, image(8));
    let mut sign_ons = 0;
    // Answer every sign-on with STATUS_CMD_FAILED, framed correctly.
    let end = run(driver.as_mut(), |write| {
        assert_eq!(write[5], 0x01, "only sign-ons may be sent: {write:02X?}");
        sign_ons += 1;
        v2_answer(1, &[0x01, 0xC0])
    });
    assert_eq!(end, FlashStep::Error { error: FlashError::SyncFailed });
    assert_eq!(sign_ons, 5);
}

/// An answer to another message (another sequence number) is not an answer,
/// however many of them come in: the sign-on fails, and the driver does not
/// read on for ever.
#[test]
fn mega_answers_with_the_wrong_sequence_number_are_never_accepted() {
    let mut driver = new_driver(BoardType::Mega, image(8));
    let mut reads = 0;
    let end = run(driver.as_mut(), |_| {
        reads += 1;
        v2_answer(9, SIGNED_ON)
    });
    assert_eq!(end, FlashStep::Error { error: FlashError::SyncFailed });
    assert!(reads < 100, "{reads} reads");
}

// --- AVR109 (Leonardo, Micro) -----------------------------------------------

#[test]
fn leonardo_image_lands_in_the_bootloaders_flash() {
    let image = image(300);
    let mut sim = SimBootloader::caterina();

    assert_eq!(flash(BoardType::Leonardo, &image, &mut sim), FlashStep::Done);

    assert_flashed(&mut sim, &image);
    assert_eq!(sim.pages_written(), 3, "one flash page per 128-byte block");
}

/// A chip erase rewrites 224 pages at up to 4.5 ms each and answers only when
/// it is done: just over two seconds on a slow chip.
#[test]
fn leonardo_flash_waits_out_a_two_second_chip_erase() {
    let image = image(300);
    let mut sim = SimBootloader::caterina().with_erase_ms(2050);

    assert_eq!(flash(BoardType::Leonardo, &image, &mut sim), FlashStep::Done);

    assert_flashed(&mut sim, &image);
}

/// `E` has to reach the bootloader before the port closes, or the board sits
/// in its bootloader for eight more seconds instead of starting the sketch.
#[test]
fn the_port_is_held_open_a_moment_after_the_exit_command() {
    let mut driver = new_driver(BoardType::Micro, image(8));
    let mut step = driver.start();
    let mut after_exit = None;
    for _ in 0..100 {
        step = match &step {
            FlashStep::Transact { write, .. } if write[0] == b'S' => driver.advance(b"CATERIN"),
            FlashStep::Transact { write, .. } if write[0] == b'E' => {
                let next = driver.advance(&[]);
                after_exit = Some(next.clone());
                next
            }
            FlashStep::Transact { .. } => driver.advance(b"\r"),
            FlashStep::Done | FlashStep::Error { .. } => break,
            _ => driver.advance(&[]),
        };
    }
    assert_eq!(after_exit, Some(FlashStep::Delay { ms: 100 }));
    assert_eq!(step, FlashStep::Done);
}

/// An identify whose answer comes in only after it was repeated: the answer
/// ends the phase, and the answer to the repeated one, which comes in ahead of
/// the erase's, is read past. The erase is not reported as unacknowledged.
#[test]
fn a_late_identifier_is_never_taken_for_the_answer_to_the_erase() {
    let mut reads = 0;
    let mut asked = Vec::new();
    let steps = transacts(BoardType::Leonardo, 5, |write, read_len| {
        reads += 1;
        asked.push((write.first().copied(), read_len));
        match reads {
            1 => Vec::new(),          // the first identify: nothing in time
            2 => b"CATERIN".to_vec(), // its answer, after the second went out
            3 => b"C".to_vec(),       // the second one's answer, where the erase's was expected
            4 => b"ATERIN\r".to_vec(),
            _ => b"\r".to_vec(),
        }
    });

    assert_eq!(
        asked,
        [(Some(b'S'), 7), (Some(b'S'), 7), (Some(b'e'), 1), (None, 6 + 1), (Some(b'A'), 1)],
        "{steps:?}"
    );
    // The repeated identify, the erase and the wait for the rest of its
    // answer keep the input; "set address" discards again.
    assert_eq!(kept_input(&steps), [false, true, true, true, false]);
}

/// No more identifiers are read past than identifies were repeated: a
/// bootloader that answers the erase with anything but a carriage return has
/// not acknowledged it.
#[test]
fn an_identifier_in_place_of_the_erase_acknowledgement_fails_the_flash() {
    let mut driver = new_driver(BoardType::Leonardo, image(8));
    let end = run(driver.as_mut(), |write| if write == b"S" { b"CATERIN".to_vec() } else { b"C".to_vec() });
    assert_eq!(
        end,
        FlashStep::Error { error: FlashError::ProgramFailed("chip erase was not acknowledged".into()) }
    );
}

/// An identifier cut in two by the end of one wait is put together in the
/// next, and one that has other bytes before it is found.
#[test]
fn an_identifier_in_pieces_or_behind_other_bytes_is_found() {
    for pieces in [[&b"CAT"[..], &b"ERIN"[..]], [&b"\0\0CATER"[..], &b"IN"[..]]] {
        let mut reads = 0;
        let steps = transacts(BoardType::Leonardo, 3, |_, _| {
            reads += 1;
            pieces.get(reads - 1).map_or_else(|| b"\r".to_vec(), |piece| piece.to_vec())
        });
        assert!(
            matches!(&steps[2], FlashStep::Transact { write, .. } if write == b"e"),
            "{pieces:?}: {steps:?}"
        );
    }
}

/// Every answer of a Leonardo a second and a half late: slower than any USB
/// link, and still inside every wait.
#[test]
fn leonardo_whose_answers_come_late_is_programmed() {
    let image = image(300);
    let mut sim = SimBootloader::caterina().with_answer_delay_ms(1500);

    assert_eq!(flash(BoardType::Leonardo, &image, &mut sim), FlashStep::Done);

    assert_flashed(&mut sim, &image);
}

/// A Leonardo whose bootloader never comes up and whose sketch talks: each
/// identify is waited for once, so a talking sketch costs no time at all.
#[test]
fn a_talking_leonardo_sketch_fails_the_identify_no_later_than_a_silent_one() {
    assert_a_talking_sketch_costs_at_most(BoardType::Leonardo, 0, &[(1, 1999), (6, 1000), (3, 100), (12, 50)]);
}

#[test]
fn a_bootloader_that_does_not_identify_as_caterina_is_never_erased() {
    let mut driver = new_driver(BoardType::Leonardo, image(8));
    let end = run(driver.as_mut(), |write| {
        assert_eq!(write, b"S", "only the identify command may be sent");
        b"AVRBOOT".to_vec()
    });
    assert_eq!(end, FlashStep::Error { error: FlashError::SyncFailed });
}

// --- Images and errors ------------------------------------------------------

/// AVR flash is programmed in 16-bit words. `stk500boot` loops forever on an
/// odd page size and Caterina drops an odd last byte, so an odd image is
/// padded with one erased byte.
#[test]
fn an_odd_length_image_is_programmed_whole() {
    let image = image(301);
    for (board, mut sim) in [
        (BoardType::Uno, SimBootloader::optiboot(115_200)),
        (BoardType::Mega, SimBootloader::stk500boot()),
        (BoardType::Leonardo, SimBootloader::caterina()),
    ] {
        assert_eq!(flash(board, &image, &mut sim), FlashStep::Done, "{board:?}");
        assert_flashed(&mut sim, &image);
    }
}

/// What a host shows for a failed flash is the error's text.
#[test]
fn an_error_step_serializes_as_its_message() {
    let step = FlashStep::Error { error: FlashError::SyncFailed };
    assert_eq!(
        serde_json::to_string(&step).unwrap(),
        r#"{"kind":"error","message":"Failed to sync with bootloader"}"#
    );
}
