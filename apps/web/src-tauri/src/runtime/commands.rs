//! Tauri Commands for the Runtime
//!
//! flow_update and component_call commands

use super::base::ComponentValue;
use super::FlowUpdate;
use crate::AppState;

/// Update the flow with new nodes and edges
#[tauri::command]
pub async fn flow_update(
    flow: FlowUpdate,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    log::info!(
        "=== FLOW UPDATE COMMAND === {} nodes, {} edges",
        flow.nodes.len(),
        flow.edges.len()
    );

    // Check if board is connected
    let board_connected = *state.board_connected.read().unwrap();
    
    if !board_connected {
        // Store as pending flow - will be applied when board connects
        log::info!("Board not connected, storing flow as pending");
        *state.pending_flow.write().unwrap() = Some(flow);
        return Ok(());
    }

    // Board is connected, apply flow immediately
    log::info!("Applying flow update to runtime");
    let mut runtime = state.flow_runtime.lock()
        .map_err(|e| format!("Lock error: {:?}", e))?;
    
    runtime.update_flow(flow)
}

/// Call a method on a component
#[tauri::command]
pub async fn component_call(
    component_id: String,
    method: String,
    args: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let value = match args {
        serde_json::Value::Bool(b) => ComponentValue::Bool(b),
        serde_json::Value::Number(n) => ComponentValue::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => ComponentValue::String(s),
        _ => ComponentValue::default(),
    };

    log::info!("Component call: {}.{}({:?})", component_id, method, value);

    let mut runtime = state.flow_runtime.lock().unwrap();
    runtime.call_component(&component_id, &method, value)
}
