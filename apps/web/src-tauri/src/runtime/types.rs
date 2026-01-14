//! Flow types matching the TypeScript runtime

use serde::{Deserialize, Serialize};

/// Position in the flow editor
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// A node in the flow graph
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: Option<String>,
    pub data: serde_json::Value,
    pub position: Position,
}

/// An edge connecting two nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdge {
    pub id: Option<String>,
    pub source: String,
    pub target: String,
    pub source_handle: String,
    pub target_handle: String,
}

/// Flow update message from frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowUpdate {
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
}
