//! WS2812 Pixel Strip Component — Output.
//!
//! Communicates with the `StandardFirmata` ws2812 extension via sysex messages.
//! Protocol uses `PIXEL_COMMAND` (0x51) with sub-commands for config, set pixel,
//! set strip, show, and shift operations.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent, RuntimeContext,
    RuntimeError,
};

pub use crate::config::pixel::PixelConfig;

// Firmata sysex command for pixel operations (matches ws2812.h)
const PIXEL_COMMAND: u8 = 0x51;

// Pixel sub-commands
const PIXEL_CONFIG: u8 = 0x01;
const PIXEL_SHOW: u8 = 0x02;
const PIXEL_SET_PIXEL: u8 = 0x03;
const PIXEL_SET_STRIP: u8 = 0x04;
const PIXEL_SHIFT: u8 = 0x05;

// Color order constants (top 2 bits of pin byte in config)
const PIXEL_COLOUR_GRB: u8 = 0x0;
const PIXEL_COLOUR_RGB: u8 = 0x1;
const PIXEL_COLOUR_BRG: u8 = 0x2;

pub struct Pixel {
    base: ComponentBase,
    config: PixelConfig,
    /// Current pixel colors as packed 24-bit RGB values
    pixels: Vec<u32>,
}

impl Pixel {
    const E_EVENT: &'static str = "event";

    #[must_use]
    pub fn new(id: String, config: PixelConfig) -> Self {
        let len = config.length as usize;
        let initial_colors = vec!["#000000".to_string(); len];
        Self {
            base: ComponentBase::new(
                id,
                ComponentValue::Array(
                    initial_colors.iter().map(|c| ComponentValue::String(c.clone())).collect(),
                ),
            ),
            pixels: vec![0u32; len],
            config,
        }
    }

    /// Parse a hex color string (#RGB or #RRGGBB) to a packed 24-bit RGB value
    fn parse_hex_color(hex: &str) -> u32 {
        let hex = hex.trim_start_matches('#');
        match hex.len() {
            3 => {
                let r = u8::from_str_radix(&hex[0..1], 16).unwrap_or(0);
                let g = u8::from_str_radix(&hex[1..2], 16).unwrap_or(0);
                let b = u8::from_str_radix(&hex[2..3], 16).unwrap_or(0);
                // Expand 4-bit to 8-bit: 0xA -> 0xAA
                u32::from(r | (r << 4)) << 16 | u32::from(g | (g << 4)) << 8 | u32::from(b | (b << 4))
            }
            6 => u32::from_str_radix(hex, 16).unwrap_or(0),
            _ => 0,
        }
    }

    /// Encode a 32-bit value into 7-bit Firmata bytes (LSB first, 4 bytes)
    fn encode_32bit(value: u32) -> [u8; 4] {
        [
            (value & 0x7F) as u8,
            ((value >> 7) & 0x7F) as u8,
            ((value >> 14) & 0x7F) as u8,
            ((value >> 21) & 0x7F) as u8,
        ]
    }

    /// Encode a 16-bit value into 7-bit Firmata bytes (LSB first, 2 bytes)
    fn encode_16bit(value: u16) -> [u8; 2] {
        [(value & 0x7F) as u8, ((value >> 7) & 0x7F) as u8]
    }

    fn color_order_byte(&self) -> u8 {
        match self.config.color_order.as_str() {
            "RGB" => PIXEL_COLOUR_RGB,
            "BRG" => PIXEL_COLOUR_BRG,
            _ => PIXEL_COLOUR_GRB, // default
        }
    }

    /// Send `PIXEL_CONFIG` sysex to configure the strip
    fn send_config(&self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // Config data: [PIXEL_CONFIG, pin_with_color_order, length_lsb, length_msb]
        let pin_byte = (self.config.pin & 0x1F) | (self.color_order_byte() << 5);
        let len_bytes = Self::encode_16bit(self.config.length);
        let data = vec![PIXEL_CONFIG, pin_byte, len_bytes[0], len_bytes[1]];
        ctx.board().sysex(PIXEL_COMMAND, &data)?;
        Ok(())
    }

    /// Send `PIXEL_SHOW` sysex to latch and display pixels
    fn send_show(&self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().sysex(PIXEL_COMMAND, &[PIXEL_SHOW])?;
        Ok(())
    }

    /// Send `PIXEL_SET_PIXEL` sysex for a single pixel
    fn send_set_pixel(
        &self,
        ctx: &mut RuntimeContext,
        index: u16,
        color: u32,
    ) -> Result<(), RuntimeError> {
        let idx = Self::encode_16bit(index);
        let col = Self::encode_32bit(color);
        let data = vec![PIXEL_SET_PIXEL, idx[0], idx[1], col[0], col[1], col[2], col[3]];
        ctx.board().sysex(PIXEL_COMMAND, &data)?;
        Ok(())
    }

    /// Send `PIXEL_SET_STRIP` sysex to set entire strip to one color
    fn send_set_strip(&self, ctx: &mut RuntimeContext, color: u32) -> Result<(), RuntimeError> {
        let col = Self::encode_32bit(color);
        let data = vec![PIXEL_SET_STRIP, col[0], col[1], col[2], col[3]];
        ctx.board().sysex(PIXEL_COMMAND, &data)?;
        Ok(())
    }

    /// Send `PIXEL_SHIFT` sysex
    fn send_shift(
        &self,
        ctx: &mut RuntimeContext,
        amount: u8,
        forward: bool,
        wrap: bool,
    ) -> Result<(), RuntimeError> {
        let mut shift_byte = amount & 0x1F;
        if forward {
            shift_byte |= 0x20;
        }
        if wrap {
            shift_byte |= 0x40;
        }
        let data = vec![PIXEL_SHIFT, shift_byte];
        ctx.board().sysex(PIXEL_COMMAND, &data)?;
        Ok(())
    }

    /// Apply an array of hex color strings to the strip
    fn apply_colors(&mut self, ctx: &mut RuntimeContext, colors: &[String]) -> Result<(), RuntimeError> {
        let len = self.config.length as usize;
        for (i, hex) in colors.iter().enumerate().take(len) {
            let color = Self::parse_hex_color(hex);
            self.pixels[i] = color;
            self.send_set_pixel(ctx, i as u16, color)?;
        }
        self.send_show(ctx)?;
        self.update_value();
        Ok(())
    }

    /// Apply a preset by index
    fn apply_preset(&mut self, ctx: &mut RuntimeContext, index: usize) -> Result<(), RuntimeError> {
        if let Some(preset) = self.config.presets.get(index) {
            let colors = preset.clone();
            self.apply_colors(ctx, &colors)?;
        }
        Ok(())
    }

    /// Turn off all pixels
    fn off(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.send_set_strip(ctx, 0)?;
        self.send_show(ctx)?;
        self.pixels.fill(0);
        self.update_value();
        Ok(())
    }

    /// Update the component value from current pixel state
    fn update_value(&mut self) {
        let colors: Vec<ComponentValue> = self
            .pixels
            .iter()
            .map(|&c| ComponentValue::String(format!("#{c:06X}")))
            .collect();
        self.base.set_value(ComponentValue::Array(colors));
    }
}

impl Component for Pixel {
    fn ports() -> &'static [&'static str] {
        &["value", "color", "set", "reset"]
    }

    fn emits() -> &'static [&'static str] {
        &[Self::E_EVENT, ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Pixel"
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "value" => {
                // Preset index selection
                let index = args.as_number().unwrap_or(0.0).round() as usize;
                // Clamp to valid preset range
                let clamped = if self.config.presets.is_empty() {
                    0
                } else {
                    index.min(self.config.presets.len() - 1)
                };
                self.apply_preset(ctx, clamped)?;
                self.base.emit(Self::E_EVENT);
                Ok(())
            }
            "color" => {
                // Direct color input - can be a single hex string or array of hex strings
                match args {
                    ComponentValue::String(hex) => {
                        // Set entire strip to one color
                        let color = Self::parse_hex_color(&hex);
                        self.send_set_strip(ctx, color)?;
                        self.send_show(ctx)?;
                        self.pixels.fill(color);
                        self.update_value();
                    }
                    ComponentValue::Array(arr) => {
                        let colors: Vec<String> = arr
                            .iter()
                            .filter_map(|v| {
                                if let ComponentValue::String(s) = v {
                                    Some(s.clone())
                                } else {
                                    None
                                }
                            })
                            .collect();
                        self.apply_colors(ctx, &colors)?;
                    }
                    _ => {
                        // Try to interpret as a number (single color channel or packed)
                        if let Some(n) = args.as_number() {
                            let color = n as u32;
                            self.send_set_strip(ctx, color)?;
                            self.send_show(ctx)?;
                            self.pixels.fill(color);
                            self.update_value();
                        }
                    }
                }
                self.base.emit(Self::E_EVENT);
                Ok(())
            }
            "set" => {
                // Shift pixels - default: 1 pixel forward with wrap
                let amount = args.as_number().unwrap_or(1.0).abs() as u8;
                let forward = args.as_number().unwrap_or(1.0) >= 0.0;
                self.send_shift(ctx, amount.max(1), forward, true)?;
                self.send_show(ctx)?;
                // Update local pixel state by rotating
                let len = self.pixels.len();
                if len > 0 && (amount as usize) < len {
                    let amt = amount as usize;
                    if forward {
                        self.pixels.rotate_right(amt);
                    } else {
                        self.pixels.rotate_left(amt);
                    }
                }
                self.update_value();
                self.base.emit(Self::E_EVENT);
                Ok(())
            }
            "reset" => {
                self.off(ctx)?;
                self.base.emit(Self::E_EVENT);
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Pixel: unknown method '{method}'"))),
        }
    }
}

impl HardwareComponent for Pixel {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.send_config(ctx)?;
        self.off(ctx)
    }
}

impl ComponentBuilder for Pixel {
    type Config = PixelConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
