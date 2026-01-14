//! Tauri command handlers

use super::types::BoardType;
use super::{FlashResult, Flasher};

/// Flash firmware to a board with custom hex content
#[tauri::command]
pub fn flash_firmware(
    port_name: String,
    board_type: BoardType,
    hex_content: String,
) -> Result<FlashResult, String> {
    Flasher::flash(&port_name, board_type, &hex_content).map_err(|e| e.to_string())
}

/// Flash StandardFirmata to a board (uses embedded hex files)
#[tauri::command]
pub fn flash_standard_firmata(
    port_name: String,
    board_type: BoardType,
) -> Result<FlashResult, String> {
    Flasher::flash_standard_firmata(&port_name, board_type).map_err(|e| e.to_string())
}

/// Auto-detect board and flash StandardFirmata
#[tauri::command]
pub fn auto_flash_firmata(
    port_name: String,
    vid: u16,
    pid: u16,
) -> Result<FlashResult, String> {
    Flasher::auto_flash_firmata(&port_name, vid, pid).map_err(|e| e.to_string())
}

/// Get list of supported board types
#[tauri::command]
pub fn get_supported_boards() -> Vec<String> {
    BoardType::all().iter().map(|b| b.as_str().to_string()).collect()
}
