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
        "Flow update: {} nodes, {} edges",
        flow.nodes.len(),
        flow.edges.len()
    );

    let mut runtime = state.flow_runtime.lock().unwrap();
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
