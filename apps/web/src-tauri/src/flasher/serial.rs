//! The flasher's serial seam: everything it asks of the machine.
//!
//! Two adapters: [`SystemSerial`] (the OS, through `serialport`) and, in tests,
//! `SimSerial` (a modelled board behind a recording port).

use std::time::{Duration, Instant};

/// Serial ports and time, as the flasher needs them.
pub(super) trait SerialHost {
    /// Open `port_name` at `baud`; `timeout` is how long one read waits for
    /// bytes. The open is exclusive: a port that is still open elsewhere, this
    /// process included, cannot be opened again.
    fn open(
        &self,
        port_name: &str,
        baud: u32,
        timeout: Duration,
    ) -> serialport::Result<Box<dyn serialport::SerialPort>>;

    /// The names of the serial ports present right now.
    fn port_names(&self) -> serialport::Result<Vec<String>>;

    /// Block for `duration`.
    fn sleep(&self, duration: Duration);

    /// The time now, on the clock that `sleep` and a port's reads run on.
    fn now(&self) -> Instant;
}

/// The real machine.
pub(super) struct SystemSerial;

impl SerialHost for SystemSerial {
    fn open(
        &self,
        port_name: &str,
        baud: u32,
        timeout: Duration,
    ) -> serialport::Result<Box<dyn serialport::SerialPort>> {
        serialport::new(port_name, baud).timeout(timeout).open()
    }

    fn port_names(&self) -> serialport::Result<Vec<String>> {
        Ok(serialport::available_ports()?.into_iter().map(|p| p.port_name).collect())
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn now(&self) -> Instant {
        Instant::now()
    }
}
