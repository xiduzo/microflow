//! Intel HEX file parser

use super::error::FlashError;

/// Parse Intel HEX format into raw binary data
pub fn parse(hex_content: &str) -> Result<Vec<u8>, FlashError> {
    let mut data = Vec::new();
    let mut extended_address: u32 = 0;

    for line in hex_content.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with(':') {
            continue;
        }

        let bytes = parse_line(&line[1..])?;
        if bytes.len() < 5 {
            continue;
        }

        let byte_count = bytes[0] as usize;
        let address = ((bytes[1] as u16) << 8) | (bytes[2] as u16);
        let record_type = bytes[3];

        match record_type {
            0x00 => {
                // Data record
                let full_address = extended_address + address as u32;
                let data_end = 4 + byte_count;

                if bytes.len() < data_end {
                    return Err(FlashError::InvalidHex("Invalid data record length".into()));
                }

                let required_len = full_address as usize + byte_count;
                if data.len() < required_len {
                    data.resize(required_len, 0xFF);
                }

                for (i, &byte) in bytes[4..data_end].iter().enumerate() {
                    data[full_address as usize + i] = byte;
                }
            }
            0x01 => break, // End of file
            0x02 if byte_count == 2 && bytes.len() >= 6 => {
                // Extended segment address
                extended_address = (((bytes[4] as u32) << 8) | (bytes[5] as u32)) << 4;
            }
            0x04 if byte_count == 2 && bytes.len() >= 6 => {
                // Extended linear address
                extended_address = (((bytes[4] as u32) << 8) | (bytes[5] as u32)) << 16;
            }
            _ => {}
        }
    }

    Ok(data)
}

fn parse_line(line: &str) -> Result<Vec<u8>, FlashError> {
    let mut bytes = Vec::new();
    let mut chars = line.chars().peekable();

    while chars.peek().is_some() {
        let high = chars.next().and_then(|c| c.to_digit(16));
        let low = chars.next().and_then(|c| c.to_digit(16));

        match (high, low) {
            (Some(h), Some(l)) => bytes.push((h * 16 + l) as u8),
            _ => break,
        }
    }

    Ok(bytes)
}
