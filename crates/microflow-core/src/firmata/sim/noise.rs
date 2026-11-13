//! Hostile input for the board → host decoder: every message the codec knows,
//! cut at every byte, and seeded random byte streams. Whatever the wire
//! delivers — line noise, a reset mid-frame, a cut reply — the decoders
//! ([`FirmataClient::feed`](crate::firmata::FirmataClient::feed) and the hosts'
//! detection sessions) must not panic: a panic there takes down the browser
//! runtime or the desktop actor.

use crate::firmata::{
    ANALOG_MAPPING_RESPONSE, ANALOG_MESSAGE, CAPABILITY_RESPONSE, DIGITAL_MESSAGE, END_SYSEX,
    EXTENDED_ANALOG, I2C_REPLY, MODE_ANALOG, MODE_INPUT, MODE_OUTPUT, PROTOCOL_VERSION,
    REPORT_FIRMWARE, START_SYSEX, STRING_DATA,
};

/// One well-formed (or minimal) instance of every message the decoder parses,
/// plus degenerate sysex frames: no command, no payload, unknown command.
#[must_use]
pub fn known_frames() -> Vec<Vec<u8>> {
    let sysex = |command: u8, data: &[u8]| {
        let mut frame = vec![START_SYSEX, command];
        frame.extend_from_slice(data);
        frame.push(END_SYSEX);
        frame
    };
    vec![
        vec![PROTOCOL_VERSION, 2, 5],
        vec![ANALOG_MESSAGE, 0x10, 0x02],
        vec![ANALOG_MESSAGE | 0x0F, 0x7F, 0x7F],
        vec![DIGITAL_MESSAGE, 0x7F, 0x01],
        vec![DIGITAL_MESSAGE | 0x0F, 0x7F, 0x7F],
        vec![START_SYSEX, END_SYSEX],
        sysex(CAPABILITY_RESPONSE, &[MODE_INPUT, 1, MODE_OUTPUT, 1, 127, MODE_ANALOG, 10, 127]),
        sysex(CAPABILITY_RESPONSE, &[]),
        sysex(CAPABILITY_RESPONSE, &[MODE_INPUT]),
        sysex(ANALOG_MAPPING_RESPONSE, &[127, 0, 1, 127]),
        sysex(ANALOG_MAPPING_RESPONSE, &[]),
        sysex(EXTENDED_ANALOG, &[17, 0x10, 0x02]),
        sysex(EXTENDED_ANALOG, &[]),
        sysex(EXTENDED_ANALOG, &[0x7F]),
        sysex(REPORT_FIRMWARE, &[2, 5, b'S', 0, b'F', 0]),
        sysex(REPORT_FIRMWARE, &[2]),
        sysex(REPORT_FIRMWARE, &[2, 5, b'S']),
        sysex(I2C_REPLY, &[0x29, 0, 0x14, 0, 0x11, 0, 0x22, 0]),
        sysex(I2C_REPLY, &[0x29, 0, 0x14, 0]),
        sysex(I2C_REPLY, &[0x29, 0, 0x14]),
        sysex(I2C_REPLY, &[0x29, 0, 0x14, 0, 0x11]),
        sysex(STRING_DATA, &[b'H', 0, b'i']),
        sysex(STRING_DATA, &[]),
        sysex(0x55, &[1, 2, 3]),
    ]
}

/// A seeded xorshift64* — deterministic noise without a dependency.
pub struct Noise(u64);

impl Noise {
    #[must_use]
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A value in `0..n` (`n > 0`).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    /// A byte, skewed towards the ones the decoder branches on: status bytes,
    /// sysex markers and the commands it parses.
    pub fn byte(&mut self) -> u8 {
        const INTERESTING: [u8; 14] = [
            START_SYSEX, END_SYSEX, PROTOCOL_VERSION, ANALOG_MESSAGE, DIGITAL_MESSAGE,
            CAPABILITY_RESPONSE, ANALOG_MAPPING_RESPONSE, EXTENDED_ANALOG, REPORT_FIRMWARE,
            I2C_REPLY, STRING_DATA, 127, 0, 0xFF,
        ];
        match self.below(3) {
            0 => INTERESTING[self.below(INTERESTING.len())],
            _ => self.next_u64() as u8,
        }
    }
}

/// The hostile corpus: every prefix of every known frame, each followed by
/// every known frame (a cut frame, then the next message), then `random`
/// streams of up to 200 bytes from `seed`.
#[must_use]
pub fn hostile_streams(seed: u64, random: usize) -> Vec<Vec<u8>> {
    let frames = known_frames();
    let mut out = Vec::new();
    for frame in &frames {
        for cut in 0..=frame.len() {
            out.push(frame[..cut].to_vec());
            for next in &frames {
                let mut stream = frame[..cut].to_vec();
                stream.extend_from_slice(next);
                out.push(stream);
            }
        }
    }
    let mut noise = Noise::new(seed);
    for _ in 0..random {
        let len = noise.below(201);
        out.push((0..len).map(|_| noise.byte()).collect());
    }
    out
}
