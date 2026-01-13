#[derive(serde::Deserialize, serde::Serialize, Debug)]
pub struct Position {
    x: f64,
    y: f64,
}

#[derive(serde::Deserialize, serde::Serialize, Debug)]
pub struct Node {
    id: String,
    #[serde(rename = "type")]
    r#type: String,
    data: serde_json::Value,
    position: Position,
}

#[derive(serde::Deserialize, serde::Serialize, Debug)]
pub struct Edge {
    source: String,
    target: String,
    #[serde(rename = "sourceHandle")]
    source_handle: String,
    #[serde(rename = "targetHandle")]
    target_handle: String,
}

#[derive(serde::Deserialize, serde::Serialize, Debug)]
pub struct FlowUpdate {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
}

#[tauri::command]
pub async fn flow_update(flow: FlowUpdate) -> Result<(), String> {
    log::info!("Flow updated: nodes={:?}, edges={:?}", flow.nodes, flow.edges);
    Ok(())
}