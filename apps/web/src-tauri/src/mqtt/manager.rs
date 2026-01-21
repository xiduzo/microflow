//! MQTT Manager
//!
//! Manages multiple broker connections with connection pooling.
//! Ensures only one connection per broker is maintained.

use super::broker::{BrokerConfig, ConnectionStatus, MessageCallback, MqttBroker};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Manages multiple MQTT broker connections
#[derive(Clone)]
pub struct MqttManager {
    brokers: Arc<RwLock<HashMap<String, Arc<tokio::sync::Mutex<MqttBroker>>>>>,
}

impl MqttManager {
    pub fn new() -> Self {
        Self {
            brokers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Connect to a broker (creates connection if not exists)
    pub async fn connect(&self, config: BrokerConfig) -> Result<(), String> {
        let mut brokers = self.brokers.write().await;

        // Check if already connected
        if let Some(broker) = brokers.get(&config.id) {
            let broker_guard = broker.lock().await;
            let status = broker_guard.status().await;
            if matches!(status, ConnectionStatus::Connected | ConnectionStatus::Connecting) {
                log::info!("[MQTT Manager] Broker {} already connected", config.id);
                return Ok(());
            }
        }

        // Create new broker connection
        let mut broker = MqttBroker::new(config.clone());
        broker.connect().await?;
        brokers.insert(config.id, Arc::new(tokio::sync::Mutex::new(broker)));

        Ok(())
    }

    /// Disconnect from a broker
    pub async fn disconnect(&self, broker_id: &str) -> Result<(), String> {
        let mut brokers = self.brokers.write().await;

        if let Some(broker) = brokers.remove(broker_id) {
            let mut broker_guard = broker.lock().await;
            broker_guard.disconnect().await?;
        }

        Ok(())
    }

    /// Disconnect all brokers
    pub async fn disconnect_all(&self) -> Result<(), String> {
        let mut brokers = self.brokers.write().await;

        for (_, broker) in brokers.drain() {
            let mut broker_guard = broker.lock().await;
            let _ = broker_guard.disconnect().await;
        }

        Ok(())
    }

    /// Get connection status for a broker
    pub async fn status(&self, broker_id: &str) -> ConnectionStatus {
        let brokers = self.brokers.read().await;

        if let Some(broker) = brokers.get(broker_id) {
            let broker_guard = broker.lock().await;
            broker_guard.status().await
        } else {
            ConnectionStatus::Disconnected
        }
    }

    /// Subscribe to a topic on a broker
    pub async fn subscribe(
        &self,
        broker_id: &str,
        topic: &str,
        callback: MessageCallback,
    ) -> Result<(), String> {
        let brokers = self.brokers.read().await;

        let broker = brokers
            .get(broker_id)
            .ok_or_else(|| format!("Broker {} not connected", broker_id))?;

        let broker_guard = broker.lock().await;
        broker_guard.subscribe(topic, callback).await
    }

    /// Unsubscribe from a topic on a broker
    pub async fn unsubscribe(&self, broker_id: &str, topic: &str) -> Result<(), String> {
        let brokers = self.brokers.read().await;

        let broker = brokers
            .get(broker_id)
            .ok_or_else(|| format!("Broker {} not connected", broker_id))?;

        let broker_guard = broker.lock().await;
        broker_guard.unsubscribe(topic).await
    }

    /// Publish a message to a topic on a broker
    pub async fn publish(
        &self,
        broker_id: &str,
        topic: &str,
        payload: &[u8],
        retain: bool,
    ) -> Result<(), String> {
        let brokers = self.brokers.read().await;

        let broker = brokers
            .get(broker_id)
            .ok_or_else(|| format!("Broker {} not connected", broker_id))?;

        let broker_guard = broker.lock().await;
        broker_guard.publish(topic, payload, retain).await
    }

    /// Check if a broker is connected
    pub async fn is_connected(&self, broker_id: &str) -> bool {
        matches!(self.status(broker_id).await, ConnectionStatus::Connected)
    }

    /// Get list of connected broker IDs
    pub async fn connected_brokers(&self) -> Vec<String> {
        let brokers = self.brokers.read().await;
        let mut connected = Vec::new();

        for (id, broker) in brokers.iter() {
            let broker_guard = broker.lock().await;
            if matches!(broker_guard.status().await, ConnectionStatus::Connected) {
                connected.push(id.clone());
            }
        }

        connected
    }
}

impl Default for MqttManager {
    fn default() -> Self {
        Self::new()
    }
}
