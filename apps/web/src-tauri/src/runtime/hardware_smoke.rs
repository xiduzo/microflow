//! Hardware smoke: the desktop runtime actor driving a real board.
//!
//! These tests need an Arduino-compatible board running `StandardFirmata` on a
//! USB serial port, so they are `#[ignore]`d and never run in CI. Run them
//! locally, one at a time (they share the board):
//!
//! ```sh
//! bun run smoke:hardware            # from apps/web; picks the first Arduino-like port
//! MICROFLOW_HW_PORT=/dev/cu.usbserial-2110 bun run smoke:hardware
//! ```
//!
//! Each test runs the real desktop path: the same Firmata detection the port
//! monitor uses, then the runtime actor (`Actor`) with the open port, driven by
//! the messages the webview sends. A test reads back what the board actually
//! did with `StandardFirmata`'s pin-state query (`0x6D` → `0x6E`), on the same
//! port, between the actor's reads. Nothing is wired to the board: pin 13 is the
//! on-board LED, so a passing run also blinks it.

use super::*;
use crate::runtime::services::RecordingMqttPublisher;
use crate::hardware::SerialPortInfo;
use microflow_core::flasher::{BoardConfig as CoreFlasher, UsbMatch};
use microflow_core::flow::{FlowNode, Position};
use std::sync::Mutex;

const PIN_STATE_QUERY: u8 = 0x6D;
const PIN_STATE_RESPONSE: u8 = 0x6E;
const START_SYSEX: u8 = 0xF0;
const END_SYSEX: u8 = 0xF7;
const MODE_OUTPUT: u8 = 1;
const LED_PIN: u8 = 13;

/// The port under test: `MICROFLOW_HW_PORT`, or the first USB serial port whose
/// VID/PID is an Arduino or an Arduino-clone bridge chip.
fn board_port() -> String {
    if let Ok(port) = std::env::var("MICROFLOW_HW_PORT") {
        return port;
    }
    let ports = crate::hardware::PortMonitor::get_ports().expect("list serial ports");
    ports
        .iter()
        .find(|p| p.usb_ids().is_some_and(|(vid, pid)| CoreFlasher::identify_usb(vid, pid).is_some()))
        .map_or_else(
            || {
                let names: Vec<_> =
                    ports.iter().map(|p| format!("{} {:?}/{:?}", p.port_name, p.vid, p.pid)).collect();
                panic!("no Arduino-like USB serial port found (set MICROFLOW_HW_PORT); ports: {names:?}")
            },
            |p| p.port_name.clone(),
        )
}

/// The real port, shared between the actor (through [`TeePort`]) and the test,
/// plus everything the board sent since the last [`Link::mark`].
struct Link {
    port: Box<dyn serialport::SerialPort>,
    received: Vec<u8>,
}

/// The actor's view of the port: reads and writes go to the real port; reads
/// are also kept in [`Link::received`] for the test to parse.
struct TeePort(Arc<Mutex<Link>>);

impl Read for TeePort {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut link = self.0.lock().unwrap();
        let n = link.port.read(buf)?;
        link.received.extend_from_slice(&buf[..n]);
        Ok(n)
    }
}

impl Write for TeePort {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().port.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().unwrap().port.flush()
    }
}

/// The actor's webview events, shared with the test thread.
#[derive(Clone, Default)]
struct SharedEvents(Arc<Mutex<Vec<(String, serde_json::Value)>>>);

impl HostEvents for SharedEvents {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        self.0.lock().unwrap().push((event.to_string(), serde_json::to_value(payload).unwrap()));
    }
    fn subscriptions_changed(&self, _wirings: Vec<(String, SubscriberWiring)>) {}
}

impl SharedEvents {
    fn named(&self, name: &str) -> Vec<serde_json::Value> {
        self.0.lock().unwrap().iter().filter(|(e, _)| e == name).map(|(_, p)| p.clone()).collect()
    }
}

/// A detected board with the runtime actor running on its port.
struct Board {
    link: Arc<Mutex<Link>>,
    tx: UnboundedSender<ActorMsg>,
    events: SharedEvents,
    stopped: Option<ActorStopped>,
    _tokio: tokio::runtime::Runtime,
}

impl Board {
    /// Detect Firmata on the board port (resetting the board, as the port
    /// monitor does) and hand the open port to a fresh actor.
    fn connect() -> Self {
        let port_name = board_port();
        let detected = crate::hardware::detect_firmata(&port_name)
            .unwrap_or_else(|| panic!("no Firmata answer on {port_name}: is StandardFirmata flashed?"));
        let mut port = detected.port;
        port.set_timeout(Duration::from_millis(READ_TIMEOUT_MS)).unwrap();
        let link = Arc::new(Mutex::new(Link { port, received: Vec::new() }));

        let tokio = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_time().build().unwrap();
        let handle = tokio.handle().clone();
        let events = SharedEvents::default();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (ended_tx, _ended_rx) = std::sync::mpsc::channel();
        let (actor_events, actor_link, self_tx, pins_json) =
            (events.clone(), Arc::clone(&link), tx.clone(), detected.pins_json);
        supervisor::install_panic_hook();
        let stopped = spawn_actor(rx, move || {
            let mut actor = Actor::new(
                actor_events,
                handle,
                Arc::new(RecordingMqttPublisher::new()),
                self_tx,
                ended_tx,
                Box::new(FlowRuntime::new),
            );
            actor.connect(Box::new(TeePort(actor_link)), pins_json, 1);
            actor
        });
        Self { link, tx, events, stopped: Some(stopped), _tokio: tokio }
    }

    fn apply(&self, nodes: Vec<FlowNode>) {
        let (reply, rx) = oneshot::channel();
        self.tx.send(ActorMsg::FlowUpdate { flow: FlowUpdate { nodes, edges: vec![] }, reply }).unwrap();
        let applied = rx.blocking_recv().expect("the actor replied to the flow update");
        applied.expect("the flow applied");
    }

    fn call(&self, id: &str, method: &str, value: ComponentValue) {
        let msg = ActorMsg::Call { id: id.into(), method: method.into(), value };
        self.tx.send(msg).unwrap();
    }

    /// The board's own answer for `pin`: `(mode, state)`. Retries until
    /// `deadline`, since a query can land while the board is rebooting.
    fn pin_state(&self, pin: u8, deadline: Duration) -> Option<(u8, u32)> {
        let until = Instant::now() + deadline;
        while Instant::now() < until {
            let start = {
                let mut link = self.link.lock().unwrap();
                let start = link.received.len();
                link.port.write_all(&[START_SYSEX, PIN_STATE_QUERY, pin, END_SYSEX]).unwrap();
                start
            };
            let answer_by = Instant::now() + Duration::from_millis(300);
            while Instant::now() < answer_by {
                std::thread::sleep(Duration::from_millis(20));
                // The actor stopped reading once it dropped the session: read here.
                if self.stopped.is_none() {
                    let mut link = self.link.lock().unwrap();
                    let mut buf = [0u8; 256];
                    if let Ok(n) = link.port.read(&mut buf) {
                        link.received.extend_from_slice(&buf[..n]);
                    }
                }
                let link = self.link.lock().unwrap();
                if let Some(answer) = parse_pin_state(&link.received[start..], pin) {
                    return Some(answer);
                }
            }
        }
        None
    }

    /// Wait until the board reports `pin` as `(mode, state)`, or fail with
    /// what it last said.
    fn expect_pin(&self, pin: u8, want: (u8, u32), deadline: Duration, why: &str) {
        let until = Instant::now() + deadline;
        let mut last = None;
        while Instant::now() < until {
            last = self.pin_state(pin, Duration::from_secs(1));
            if last == Some(want) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("{why}: pin {pin} is {last:?} (mode, state), expected {want:?}");
    }

    /// Pulse DTR, which resets an Arduino with auto-reset (every Uno/Nano and
    /// their clones): the board reboots under the live session.
    fn reset_board(&self) {
        let mut link = self.link.lock().unwrap();
        let _ = link.port.write_data_terminal_ready(false);
        std::thread::sleep(Duration::from_millis(100));
        let _ = link.port.write_data_terminal_ready(true);
    }

    /// End the session the way the app does (dropping it writes the safe
    /// state), stop the actor, and keep the port so the test can still query.
    fn shut_down(&mut self) {
        self.tx.send(ActorMsg::Shutdown).unwrap();
        let stopped = self.stopped.take().expect("running");
        assert!(stopped.wait(Duration::from_secs(2)), "the actor stopped");
    }
}

impl Drop for Board {
    fn drop(&mut self) {
        if self.stopped.is_some() {
            let _ = self.tx.send(ActorMsg::Shutdown);
            if let Some(stopped) = self.stopped.take() {
                let _ = stopped.wait(Duration::from_secs(2));
            }
        }
    }
}

/// The first `PIN_STATE_RESPONSE` for `pin` in `bytes`: `(mode, state)`, the
/// state being 7-bit little-endian groups.
fn parse_pin_state(bytes: &[u8], pin: u8) -> Option<(u8, u32)> {
    let mut i = 0;
    while i + 4 < bytes.len() {
        if bytes[i] == START_SYSEX && bytes[i + 1] == PIN_STATE_RESPONSE && bytes[i + 2] == pin {
            let mode = bytes[i + 3];
            let end = bytes[i + 4..].iter().position(|&b| b == END_SYSEX)? + i + 4;
            let state = bytes[i + 4..end].iter().rev().fold(0u32, |acc, &b| (acc << 7) | u32::from(b & 0x7F));
            return Some((mode, state));
        }
        i += 1;
    }
    None
}

fn node(id: &str, instance: &str, data: serde_json::Value) -> FlowNode {
    FlowNode { id: id.to_string(), node_type: Some(instance.to_string()), data, position: Position { x: 0.0, y: 0.0 } }
}

fn led() -> FlowNode {
    node("led", "Led", serde_json::json!({ "instance": "Led", "pin": LED_PIN }))
}

const ON: (u8, u32) = (MODE_OUTPUT, 1);
const OFF: (u8, u32) = (MODE_OUTPUT, 0);
const SETTLE: Duration = Duration::from_secs(3);

#[test]
#[ignore = "needs a board running StandardFirmata (bun run smoke:hardware)"]
fn the_board_is_recognised_and_answers_firmata() {
    let port_name = board_port();
    let info = crate::hardware::PortMonitor::get_ports()
        .unwrap()
        .into_iter()
        .find(|p| p.port_name == port_name);
    if let Some((vid, pid)) = info.as_ref().and_then(SerialPortInfo::usb_ids) {
        let identified = CoreFlasher::identify_usb(vid, pid);
        eprintln!("{port_name}: {vid:04x}:{pid:04x} → {identified:?}");
        assert!(identified.is_some(), "a known board or clone bridge chip");
        if let Some(UsbMatch::BridgeChip { .. }) = identified {
            assert!(
                CoreFlasher::detect_from_usb(vid, pid).is_none(),
                "a bridge chip is offered a flash, never flashed without asking"
            );
        }
    }

    let detected = crate::hardware::detect_firmata(&port_name).expect("Firmata answers");
    let crate::hardware::BoardState::Connected { firmware_name, firmware_version, pins, .. } = detected.state else {
        panic!("detection did not report a connected board");
    };
    eprintln!("firmware {firmware_name} {firmware_version}, {} pins", pins.len());
    assert!(!firmware_name.is_empty() && firmware_name.is_ascii(), "the firmware name decodes: {firmware_name:?}");
    assert!(pins.len() >= 20, "an Uno-class pin table");
    let pins_json: serde_json::Value = serde_json::from_str(&detected.pins_json).unwrap();
    let pins_json = pins_json.as_array().unwrap();
    let led = &pins_json[usize::from(LED_PIN)];
    assert!(
        led["supportedModes"].as_array().unwrap().contains(&serde_json::json!(MODE_OUTPUT)),
        "pin 13 is a digital output: {led}"
    );
    assert!(pins_json.iter().any(|p| p["analogChannel"] == 0), "A0 is mapped");
}

#[test]
#[ignore = "needs a board running StandardFirmata (bun run smoke:hardware)"]
fn a_led_flow_drives_the_board_and_exit_leaves_it_safe() {
    let mut board = Board::connect();
    board.apply(vec![led()]);

    board.call("led", "true", ComponentValue::Bool(true));
    board.expect_pin(LED_PIN, ON, SETTLE, "Led true");
    board.call("led", "false", ComponentValue::Bool(false));
    board.expect_pin(LED_PIN, OFF, SETTLE, "Led false");
    board.call("led", "toggle", ComponentValue::Bool(true));
    board.expect_pin(LED_PIN, ON, SETTLE, "Led toggle");

    // App exit: the session drop writes the safe state before the actor stops.
    board.shut_down();
    board.expect_pin(LED_PIN, OFF, SETTLE, "the safe state after exit");
}

#[test]
#[ignore = "needs a board running StandardFirmata (bun run smoke:hardware)"]
fn a_board_reset_mid_session_restores_the_flow() {
    let board = Board::connect();
    board.apply(vec![led()]);
    board.call("led", "true", ComponentValue::Bool(true));
    board.expect_pin(LED_PIN, ON, SETTLE, "Led true");

    // The board reboots and re-announces its firmware; the runtime re-applies
    // the flow and restores the LED it was driving.
    let mark = board.link.lock().unwrap().received.len();
    board.reset_board();
    // The board announces its firmware once it has rebooted: proof the reset
    // happened, so the ON below is the runtime's restore, not a leftover.
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let announced = board.link.lock().unwrap().received[mark..].windows(2).any(|w| w == [START_SYSEX, 0x79]);
        if announced {
            break;
        }
        assert!(Instant::now() < until, "the board never re-announced its firmware after the reset");
        std::thread::sleep(Duration::from_millis(50));
    }
    board.expect_pin(LED_PIN, ON, Duration::from_secs(10), "the LED after a board reset");
    assert!(board.events.named("runtime-crashed").is_empty(), "no crash");
}

#[test]
#[ignore = "needs a board running StandardFirmata (bun run smoke:hardware)"]
fn analog_input_reaches_the_flow() {
    let board = Board::connect();
    board.link.lock().unwrap().received.clear();
    board.apply(vec![node(
        "pot",
        "Sensor",
        serde_json::json!({ "instance": "Sensor", "pin": "A0", "type": "analog", "threshold": 0 }),
    )]);

    let until = Instant::now() + SETTLE;
    let mut analog_reports = 0;
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(100));
        // ANALOG_MESSAGE on channel 0: 0xE0.
        analog_reports = board.link.lock().unwrap().received.iter().fold(0, |n, &b| n + usize::from(b == 0xE0));
        if analog_reports >= 5 && !board.events.named("component-events").is_empty() {
            break;
        }
    }
    assert!(analog_reports >= 5, "the board streams A0 once the flow enables it ({analog_reports} reports)");
    let events = board.events.named("component-events");
    assert!(
        events.iter().any(|batch| batch.to_string().contains("\"pot\"")),
        "the Sensor emitted from the board's readings: {events:?}"
    );
    assert!(board.events.named("node-diagnostic").iter().all(|d| d["severity"] != "error"), "no node errors");
}

#[test]
#[ignore = "needs a board running StandardFirmata (bun run smoke:hardware)"]
fn a_second_session_reconnects_to_the_same_board() {
    // Replug, as far as software can: the first session ends and releases
    // the port, and detection on the same port finds the board again.
    let mut first = Board::connect();
    first.apply(vec![led()]);
    first.shut_down();
    drop(first);

    let second = Board::connect();
    second.apply(vec![led()]);
    second.call("led", "true", ComponentValue::Bool(true));
    second.expect_pin(LED_PIN, ON, SETTLE, "Led true on the second session");
}

#[test]
fn pin_state_responses_parse() {
    assert_eq!(parse_pin_state(&[0x90, 0, 0, START_SYSEX, PIN_STATE_RESPONSE, 13, 1, 1, END_SYSEX], 13), Some((1, 1)));
    // Multi-byte state: 200 = 0x48 | (0x01 << 7).
    assert_eq!(parse_pin_state(&[START_SYSEX, PIN_STATE_RESPONSE, 9, 3, 0x48, 0x01, END_SYSEX], 9), Some((3, 200)));
    assert_eq!(parse_pin_state(&[START_SYSEX, PIN_STATE_RESPONSE, 9, 3, 0x48], 9), None, "incomplete");
    assert_eq!(parse_pin_state(&[START_SYSEX, PIN_STATE_RESPONSE, 12, 1, 1, END_SYSEX], 13), None, "other pin");
}
