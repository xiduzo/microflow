//! Input Components
//!
//! Components that read data from hardware: buttons, sensors, motion detectors, etc.

mod button;
mod motion;
mod proximity;
mod sensor;
mod switch;

pub use button::{Button, ButtonConfig};
pub use motion::{Motion, MotionConfig};
pub use proximity::{Proximity, ProximityConfig};
pub use sensor::{Sensor, SensorConfig};
pub use switch::{Switch, SwitchConfig};
