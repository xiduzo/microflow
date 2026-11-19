//! `SimSerial`: the test adapter of the flasher's [`SerialHost`] seam.
//!
//! A modelled board (`microflow_core::flasher::sim::SimBootloader`) behind a
//! port that records every call made on it, on the model's virtual clock. A
//! test gets two things from it: the **transcript** (what the flasher did to
//! the port, in order, sleeps included) and the board's state afterwards (what
//! is in its flash, how the bootloader was left).
//!
//! What it models of the machine:
//!
//! - Opens are exclusive, as `serialport` makes them (`TIOCEXCL` + `flock`).
//!   On request a port also stays busy for a while after it is closed, as it
//!   does with a serial driver that finishes the close late.
//! - A board behind a USB-serial bridge (Uno, Nano, Mega) resets into its
//!   bootloader when DTR is asserted, which opening the port also does.
//! - A native-USB board (Leonardo, Micro) drops off the bus when its port is
//!   at 1200 baud with DTR low, and comes back as its bootloader a moment
//!   later, on the same port name or another.

use super::serial::SerialHost;
use microflow_core::flasher::sim::SimBootloader;
use serialport::{ClearBuffer, DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How long the sketch's USB stack stays up after a 1200-baud touch (the
/// Arduino core's 120 ms watchdog).
const TOUCH_TO_DETACH_MS: u64 = 120;

/// A native-USB board's trip through its bootloader.
struct NativeUsb {
    bootloader_port: String,
    /// Touch to bootloader port present, in ms.
    enumerate_ms: u64,
    /// When the sketch was told to reboot into the bootloader.
    touched_at: Option<u64>,
    /// The bootloader came up after that touch.
    booted: bool,
}

struct World {
    /// The bridge's port, or the sketch's on a native-USB board.
    port_name: String,
    boot: SimBootloader,
    native: Option<NativeUsb>,
    /// The one port that is open, if any, and its line state.
    open: Option<String>,
    baud: u32,
    dtr: bool,
    log: Vec<String>,
    /// The image being flashed and its page size, to print page data by name.
    image: Vec<u8>,
    chunk: usize,
    /// The most bytes one read hands over, as a bridge that forwards in small
    /// USB packets would.
    max_read: usize,
    /// How long a port stays busy after a close, and when the last one was.
    busy_after_close_ms: u64,
    closed_at: Option<u64>,
    /// What the virtual clock's 0 ms is as an `Instant`.
    epoch: Instant,
}

impl World {
    fn now(&self) -> u64 {
        self.boot.now_ms()
    }

    /// Let `ms` pass, starting the bootloader on the way if its time comes.
    fn advance(&mut self, ms: u64) {
        let mut left = ms;
        if let Some(native) = &mut self.native {
            if let (Some(touched_at), false) = (native.touched_at, native.booted) {
                let boots_at = touched_at + native.enumerate_ms;
                let until_boot = boots_at.saturating_sub(self.boot.now_ms());
                if until_boot <= left {
                    self.boot.sleep(until_boot as u32);
                    self.boot.reset();
                    native.booted = true;
                    left -= until_boot;
                }
            }
        }
        self.boot.sleep(left as u32);
    }

    /// The ports the OS lists right now.
    fn present(&mut self) -> Vec<String> {
        let now = self.now();
        let in_bootloader = self.boot.in_bootloader();
        match &mut self.native {
            None => vec![self.port_name.clone()],
            Some(native) => match native.touched_at {
                None => vec![self.port_name.clone()],
                Some(touched_at) if now < touched_at + TOUCH_TO_DETACH_MS => vec![self.port_name.clone()],
                Some(_) if !native.booted => Vec::new(),
                Some(_) if in_bootloader => vec![native.bootloader_port.clone()],
                Some(_) => {
                    // The bootloader started the sketch: back to the sketch's port.
                    native.touched_at = None;
                    native.booted = false;
                    vec![self.port_name.clone()]
                }
            },
        }
    }

    /// The open port's device is still on the bus.
    fn attached(&mut self) -> bool {
        let Some(open) = self.open.clone() else { return false };
        self.present().contains(&open)
    }

    /// Whether the open port leads to the bootloader (not the sketch).
    fn talks_to_bootloader(&mut self) -> bool {
        match &self.native {
            None => true,
            Some(native) => native.booted && self.open.as_deref() == Some(native.bootloader_port.as_str()),
        }
    }

    /// The line state changed: reset or touch the board as the hardware would.
    fn line_changed(&mut self, dtr: bool) {
        let was = self.dtr;
        self.dtr = dtr;
        let now = self.now();
        match &mut self.native {
            // The reset capacitor sits on DTR: asserting it pulses RESET.
            None if dtr && !was => self.boot.reset(),
            Some(native) if native.touched_at.is_none() && self.baud == 1200 && !dtr => {
                native.touched_at = Some(now);
            }
            _ => {}
        }
    }

    fn gone() -> io::Error {
        io::Error::new(io::ErrorKind::BrokenPipe, "Device not configured")
    }

    /// Bytes as hex, with a whole page of the image printed by its range.
    fn hex(&self, bytes: &[u8]) -> String {
        let plain = |b: &[u8]| b.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ");
        if self.chunk > 0 {
            for (index, page) in self.image.chunks(self.chunk).enumerate() {
                if page.len() < 8 {
                    continue;
                }
                if let Some(at) = bytes.windows(page.len()).position(|w| w == page) {
                    let start = index * self.chunk;
                    let parts = [
                        plain(&bytes[..at]),
                        format!("image[{start}..{}]", start + page.len()),
                        plain(&bytes[at + page.len()..]),
                    ];
                    return parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
                }
            }
        }
        plain(bytes)
    }
}

/// A machine with one modelled board plugged in. Cheap to clone; all clones
/// are the same machine.
#[derive(Clone)]
pub(super) struct SimSerial(Arc<Mutex<World>>);

impl SimSerial {
    /// A board behind a USB-serial bridge on `port_name`, sketch running.
    pub(super) fn bridged(port_name: &str, boot: SimBootloader) -> Self {
        Self(Arc::new(Mutex::new(World {
            port_name: port_name.to_string(),
            boot,
            native: None,
            open: None,
            baud: 0,
            dtr: false,
            log: Vec::new(),
            image: Vec::new(),
            chunk: 0,
            max_read: usize::MAX,
            busy_after_close_ms: 0,
            closed_at: None,
            epoch: Instant::now(),
        })))
    }

    /// A native-USB board whose sketch is on `port_name` and whose bootloader
    /// shows up on `bootloader_port`, `enumerate_ms` after a 1200-baud touch.
    pub(super) fn native_usb(
        port_name: &str,
        bootloader_port: &str,
        enumerate_ms: u64,
        boot: SimBootloader,
    ) -> Self {
        let sim = Self::bridged(port_name, boot);
        sim.world().native = Some(NativeUsb {
            bootloader_port: bootloader_port.to_string(),
            enumerate_ms,
            touched_at: None,
            booted: false,
        });
        sim
    }

    /// Print `image`'s pages (`chunk` bytes each) by range in the transcript.
    pub(super) fn naming_pages_of(self, image: &[u8], chunk: usize) -> Self {
        {
            let mut world = self.world();
            world.image = image.to_vec();
            world.chunk = chunk;
        }
        self
    }

    /// Hand over at most `max` bytes per read, however many have arrived.
    pub(super) fn reading_at_most(self, max: usize) -> Self {
        self.world().max_read = max;
        self
    }

    /// Refuse to open a port for `ms` after it was closed.
    pub(super) fn busy_after_close(self, ms: u64) -> Self {
        self.world().busy_after_close_ms = ms;
        self
    }

    fn world(&self) -> MutexGuard<'_, World> {
        self.0.lock().unwrap()
    }

    /// Everything done to the machine so far, one call per line.
    pub(super) fn transcript(&self) -> String {
        self.world().log.join("\n")
    }

    /// Look at (or poke) the board's bootloader model.
    pub(super) fn board<R>(&self, look: impl FnOnce(&mut SimBootloader) -> R) -> R {
        look(&mut self.world().boot)
    }

    pub(super) fn is_native_usb(&self) -> bool {
        self.world().native.is_some()
    }

    /// Virtual ms since the test started.
    pub(super) fn elapsed_ms(&self) -> u64 {
        self.world().now()
    }
}

impl SerialHost for SimSerial {
    fn open(&self, port_name: &str, baud: u32, timeout: Duration) -> serialport::Result<Box<dyn SerialPort>> {
        let mut world = self.world();
        let refuse = |world: &mut World, kind, why: &str| {
            world.log.push(format!("open {port_name} @{baud} -> {why}"));
            Err(serialport::Error::new(kind, why))
        };
        if world.open.is_some() {
            return refuse(&mut world, serialport::ErrorKind::NoDevice, "Device or resource busy");
        }
        let now = world.now();
        if world.closed_at.is_some_and(|at| now < at + world.busy_after_close_ms) {
            return refuse(&mut world, serialport::ErrorKind::NoDevice, "Resource busy");
        }
        if !world.present().iter().any(|p| p == port_name) {
            return refuse(
                &mut world,
                serialport::ErrorKind::Io(io::ErrorKind::NotFound),
                "No such file or directory",
            );
        }
        world.log.push(format!("open {port_name} @{baud} timeout {}ms", timeout.as_millis()));
        world.open = Some(port_name.to_string());
        world.baud = baud;
        world.boot.set_baud(baud);
        // Opening a serial port asserts DTR.
        world.line_changed(true);
        Ok(Box::new(SimPort { world: Arc::clone(&self.0), name: port_name.to_string(), timeout }))
    }

    fn port_names(&self) -> serialport::Result<Vec<String>> {
        let mut world = self.world();
        let present = world.present();
        world.log.push(format!("list ports -> {present:?}"));
        Ok(present)
    }

    fn sleep(&self, duration: Duration) {
        let mut world = self.world();
        world.log.push(format!("sleep {}", duration.as_millis()));
        world.advance(duration.as_millis() as u64);
    }

    fn now(&self) -> Instant {
        let world = self.world();
        world.epoch + Duration::from_millis(world.now())
    }
}

/// An open port on the simulated machine.
struct SimPort {
    world: Arc<Mutex<World>>,
    name: String,
    timeout: Duration,
}

impl SimPort {
    fn world(&self) -> MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }

    fn set_line(&self, line: &str, level: bool) -> serialport::Result<()> {
        let mut world = self.world();
        if !world.attached() {
            world.log.push(format!("{line} {} -> device gone", u8::from(level)));
            return Err(World::gone().into());
        }
        world.log.push(format!("{line} {}", u8::from(level)));
        if line == "dtr" {
            world.line_changed(level);
        }
        Ok(())
    }
}

impl Drop for SimPort {
    fn drop(&mut self) {
        let mut world = self.world();
        world.log.push(format!("close {}", self.name));
        // Closing drops DTR, which at 1200 baud is the touch as well.
        world.line_changed(false);
        world.open = None;
        world.closed_at = Some(world.now());
    }
}

impl Read for SimPort {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let timeout_ms = self.timeout.as_millis() as u64;
        let mut world = self.world();
        if !world.attached() {
            world.log.push("rx -> device gone".to_string());
            return Err(World::gone());
        }
        let got = if world.talks_to_bootloader() {
            let max = buf.len().min(world.max_read);
            world.boot.read(max, timeout_ms as u32)
        } else {
            world.advance(timeout_ms);
            Vec::new()
        };
        if got.is_empty() {
            world.log.push(format!("rx timeout {timeout_ms}ms (wanted {})", buf.len()));
            return Err(io::Error::new(io::ErrorKind::TimedOut, "Operation timed out"));
        }
        let line = format!("rx {}", world.hex(&got));
        world.log.push(line);
        buf[..got.len()].copy_from_slice(&got);
        Ok(got.len())
    }
}

impl Write for SimPort {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut world = self.world();
        if !world.attached() {
            world.log.push("tx -> device gone".to_string());
            return Err(World::gone());
        }
        let line = format!("tx {}", world.hex(buf));
        world.log.push(line);
        if world.talks_to_bootloader() {
            world.boot.write(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.world().log.push("flush".to_string());
        Ok(())
    }
}

impl SerialPort for SimPort {
    fn name(&self) -> Option<String> {
        Some(self.name.clone())
    }
    fn baud_rate(&self) -> serialport::Result<u32> {
        Ok(self.world().baud)
    }
    fn data_bits(&self) -> serialport::Result<DataBits> {
        Ok(DataBits::Eight)
    }
    fn flow_control(&self) -> serialport::Result<FlowControl> {
        Ok(FlowControl::None)
    }
    fn parity(&self) -> serialport::Result<Parity> {
        Ok(Parity::None)
    }
    fn stop_bits(&self) -> serialport::Result<StopBits> {
        Ok(StopBits::One)
    }
    fn timeout(&self) -> Duration {
        self.timeout
    }
    fn set_baud_rate(&mut self, baud_rate: u32) -> serialport::Result<()> {
        let mut world = self.world();
        world.log.push(format!("baud {baud_rate}"));
        world.baud = baud_rate;
        world.boot.set_baud(baud_rate);
        Ok(())
    }
    fn set_data_bits(&mut self, _: DataBits) -> serialport::Result<()> {
        Ok(())
    }
    fn set_flow_control(&mut self, _: FlowControl) -> serialport::Result<()> {
        Ok(())
    }
    fn set_parity(&mut self, _: Parity) -> serialport::Result<()> {
        Ok(())
    }
    fn set_stop_bits(&mut self, _: StopBits) -> serialport::Result<()> {
        Ok(())
    }
    fn set_timeout(&mut self, timeout: Duration) -> serialport::Result<()> {
        // Not a call on the device: `serialport` only stores it for later reads.
        self.timeout = timeout;
        Ok(())
    }
    fn write_request_to_send(&mut self, level: bool) -> serialport::Result<()> {
        self.set_line("rts", level)
    }
    fn write_data_terminal_ready(&mut self, level: bool) -> serialport::Result<()> {
        self.set_line("dtr", level)
    }
    fn read_clear_to_send(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_data_set_ready(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_ring_indicator(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_carrier_detect(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn bytes_to_read(&self) -> serialport::Result<u32> {
        Ok(0)
    }
    fn bytes_to_write(&self) -> serialport::Result<u32> {
        Ok(0)
    }
    fn clear(&self, buffer_to_clear: ClearBuffer) -> serialport::Result<()> {
        let mut world = self.world();
        let which = match buffer_to_clear {
            ClearBuffer::Input => "input",
            ClearBuffer::Output => "output",
            ClearBuffer::All => "all",
        };
        world.log.push(format!("clear {which}"));
        if !matches!(buffer_to_clear, ClearBuffer::Output) {
            world.boot.discard_input();
        }
        Ok(())
    }
    fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> {
        Err(serialport::Error::new(serialport::ErrorKind::Unknown, "a simulated port is not cloneable"))
    }
    fn set_break(&self) -> serialport::Result<()> {
        Ok(())
    }
    fn clear_break(&self) -> serialport::Result<()> {
        Ok(())
    }
}
