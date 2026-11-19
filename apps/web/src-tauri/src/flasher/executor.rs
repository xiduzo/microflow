//! The desktop executor of the core flash drivers.
//!
//! A `microflow_core::flasher::FlashDriver` decides what a flash is: which
//! bytes, in which order, which answers are good enough, when to retry and
//! when to give up. [`run`] carries its steps out on a serial port, blocking,
//! and feeds back what the board answered. The browser's executor does the
//! same against Web Serial.
//!
//! What stays here, because it is about this machine and not about the
//! protocol:
//!
//! - opening and closing the port (exclusive, so always closed before it is
//!   opened again, with a moment for the driver to let go of it), and the
//!   DTR/RTS writes of a reset step;
//! - finding a native-USB board again after its 1200-baud touch
//!   ([`Session::reacquire`]): the board re-enumerates as its bootloader, on
//!   the same port name or a new one, and the cadence of looking for it is
//!   what real boards were brought up with;
//! - how a read waits and what a failed read or write means.

use super::serial::SerialHost;
use super::FlashError;
use microflow_core::flasher::{FlashDriver, FlashStep};
use serialport::{ClearBuffer, SerialPort};
use std::io::ErrorKind;
use std::time::Duration;

/// Read timeout a port is opened with; each transact sets its own.
const OPEN_TIMEOUT: Duration = Duration::from_secs(1);
/// How long a port is left alone after it is closed, before it is opened
/// again. Closing returns before every serial driver has let go of the device.
const REOPEN_SETTLE: Duration = Duration::from_millis(100);
/// If the port is still busy then, the open is tried this many times in all,
/// this far apart: up to half a second for a slow driver, no more.
const REOPEN_ATTEMPTS: u32 = 5;
const REOPEN_RETRY: Duration = Duration::from_millis(100);
/// How often, and how many times, the port list is searched for a bootloader
/// that is re-enumerating.
const REACQUIRE_POLL: Duration = Duration::from_millis(100);
const REACQUIRE_POLLS: u32 = 30;
/// Read timeout of the open that only tests whether a found port is ready.
const REACQUIRE_PROBE_TIMEOUT: Duration = Duration::from_millis(100);
/// Read timeout the bootloader's port is opened with.
const BOOTLOADER_OPEN_TIMEOUT: Duration = Duration::from_secs(2);
/// More steps than any flash takes (a full 256 KB Mega is about 3000): a
/// driver that passes it is stuck, and the thread running it must get out.
const MAX_STEPS: u32 = 1_000_000;

/// Run `driver` to its end against the board on `port_name`, opening the port
/// at `baud` unless the driver's first step asks for another rate. The port is
/// closed when this returns.
pub(super) fn run(
    host: &dyn SerialHost,
    port_name: &str,
    baud: u32,
    driver: &mut dyn FlashDriver,
) -> Result<(), FlashError> {
    let mut session = Session { host, port_name: port_name.to_string(), baud, port: None };
    let mut step = driver.start();
    for _ in 0..MAX_STEPS {
        let input = match step {
            FlashStep::Done => return Ok(()),
            FlashStep::Error { error } => return Err(error),
            FlashStep::Reset { dtr, rts, delay_ms } => {
                session.set_lines(dtr, rts)?;
                host.sleep(Duration::from_millis(u64::from(delay_ms)));
                Vec::new()
            }
            FlashStep::SetBaud { baud } => {
                log::info!("Opening {} at {baud} baud", session.port_name);
                session.baud = baud;
                session.reopen()?;
                Vec::new()
            }
            FlashStep::FlushInput => {
                session.discard_input()?;
                Vec::new()
            }
            FlashStep::Transact { write, read_len, timeout_ms, keep_input } => {
                let timeout = Duration::from_millis(u64::from(timeout_ms));
                session.transact(&write, read_len, timeout, keep_input)?
            }
            FlashStep::Delay { ms } => {
                host.sleep(Duration::from_millis(u64::from(ms)));
                Vec::new()
            }
            FlashStep::ReacquirePort { wait_ms, baud } => {
                session.baud = baud;
                session.reacquire(Duration::from_millis(u64::from(wait_ms)))?;
                Vec::new()
            }
            FlashStep::Progress { done, total } => {
                if done % 20 == 0 || done == total {
                    log::debug!("Progress: {done}/{total} pages");
                }
                Vec::new()
            }
        };
        step = driver.advance(&input);
    }
    Err(FlashError::Communication("the flash driver did not finish".into()))
}

/// The port a flash holds, and where to find it.
struct Session<'a> {
    host: &'a dyn SerialHost,
    /// Changes when a bootloader re-enumerates under another name.
    port_name: String,
    baud: u32,
    port: Option<Box<dyn SerialPort>>,
}

impl Session<'_> {
    /// The open port, opened on first use.
    fn port(&mut self) -> Result<&mut Box<dyn SerialPort>, FlashError> {
        let port = match self.port.take() {
            Some(port) => port,
            None => self
                .host
                .open(&self.port_name, self.baud, OPEN_TIMEOUT)
                .map_err(|e| FlashError::PortOpen(e.to_string()))?,
        };
        Ok(self.port.insert(port))
    }

    /// Close the port, then open it at the current baud. In that order: the
    /// open is exclusive, so a port still held cannot be opened again. The
    /// driver resets the board after every reopen, so the time this takes is
    /// not part of any bootloader's window.
    fn reopen(&mut self) -> Result<(), FlashError> {
        if self.port.take().is_none() {
            // Nothing was open (AVR109 opens at 1200 baud first): a plain open.
            return self.port().map(|_| ());
        }
        self.host.sleep(REOPEN_SETTLE);
        let mut attempt = 1;
        loop {
            match self.host.open(&self.port_name, self.baud, OPEN_TIMEOUT) {
                Ok(port) => {
                    self.port = Some(port);
                    return Ok(());
                }
                Err(e) if attempt < REOPEN_ATTEMPTS => {
                    log::debug!("Reopening {} failed ({e}), attempt {attempt}", self.port_name);
                    attempt += 1;
                    self.host.sleep(REOPEN_RETRY);
                }
                Err(e) => return Err(FlashError::PortOpen(e.to_string())),
            }
        }
    }

    fn set_lines(&mut self, dtr: bool, rts: bool) -> Result<(), FlashError> {
        let port = self.port()?;
        port.write_data_terminal_ready(dtr).map_err(|e| FlashError::Io(e.to_string()))?;
        port.write_request_to_send(rts).map_err(|e| FlashError::Io(e.to_string()))
    }

    fn discard_input(&mut self) -> Result<(), FlashError> {
        // Best effort: a stale byte that survives shows up as a bad answer.
        let _ = self.port()?.clear(ClearBuffer::Input);
        Ok(())
    }

    /// Discard buffered input unless `keep_input`, write `write` (if any),
    /// then read up to `read_len` bytes until `timeout` after the write: one
    /// deadline for the step, which bytes coming in do not extend. Returns
    /// what arrived: fewer bytes than asked for is the driver's to judge, as
    /// a timeout.
    fn transact(
        &mut self,
        write: &[u8],
        read_len: usize,
        timeout: Duration,
        keep_input: bool,
    ) -> Result<Vec<u8>, FlashError> {
        let host = self.host;
        let port = self.port()?;
        // Bootloaders answer a command and say nothing else: whatever is
        // buffered before a command is stale (reset noise, a sketch's output)
        // and would be read as this one's answer. A transact discards it, as
        // the browser's executor does, unless the driver asks to keep the
        // input: then an answer that came in late is in it, and the driver
        // reads on from where the last transact stopped.
        if !keep_input {
            let _ = port.clear(ClearBuffer::Input);
        }
        if !write.is_empty() {
            port.write_all(write).map_err(|e| FlashError::Communication(e.to_string()))?;
            if let Err(e) = port.flush() {
                log::debug!("Flush failed: {e}");
            }
        }

        let mut input = vec![0u8; read_len];
        let mut filled = 0;
        let deadline = host.now() + timeout;
        while filled < read_len {
            // Each read waits only for what is left of the step's time.
            let left = deadline.saturating_duration_since(host.now());
            if left.is_zero() {
                break;
            }
            if port.timeout() != left {
                port.set_timeout(left).map_err(|e| FlashError::Io(e.to_string()))?;
            }
            match port.read(&mut input[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => {
                    if e.kind() != ErrorKind::TimedOut {
                        log::debug!("Read failed after {filled}/{read_len} bytes: {e}");
                    }
                    break;
                }
            }
        }
        input.truncate(filled);
        Ok(input)
    }

    /// Let go of the port of a board that was just told to reboot into its
    /// bootloader, wait `wait`, and open the port the bootloader shows up on.
    fn reacquire(&mut self, wait: Duration) -> Result<(), FlashError> {
        // Closing the port, at 1200 baud with DTR low, is what triggers the reboot.
        self.port = None;
        log::debug!("Waiting for bootloader to appear...");
        self.host.sleep(wait);

        let found = self.find_bootloader()?;
        log::info!("Bootloader ready on {found}");
        self.port_name = found;
        let port = self
            .host
            .open(&self.port_name, self.baud, BOOTLOADER_OPEN_TIMEOUT)
            .map_err(|e| FlashError::PortOpen(format!("Failed to open bootloader port: {e}")))?;
        self.port = Some(port);
        Ok(())
    }

    /// Look for the bootloader's port until it can be opened: the original
    /// port name first, then any native-USB serial port.
    fn find_bootloader(&self) -> Result<String, FlashError> {
        let opens = |name: &str| self.host.open(name, self.baud, REACQUIRE_PROBE_TIMEOUT).is_ok();
        for attempt in 0..REACQUIRE_POLLS {
            self.host.sleep(REACQUIRE_POLL);
            let Ok(ports) = self.host.port_names() else { continue };
            if attempt < 3 || attempt % 10 == 0 {
                log::debug!("Attempt {}: available ports: {ports:?}", attempt + 1);
            }
            if ports.contains(&self.port_name) && opens(&self.port_name) {
                return Ok(self.port_name.clone());
            }
            let other = ports
                .iter()
                .find(|name| (name.contains("usbmodem") || name.contains("ttyACM")) && opens(name));
            if let Some(name) = other {
                return Ok(name.clone());
            }
        }
        Err(FlashError::BoardNotFound(format!(
            "Bootloader not found after reset (original port: {})",
            self.port_name
        )))
    }
}
