//! MQTT Manager
//!
//! Manages multiple broker connections with connection pooling.
//! Ensures only one connection per broker is maintained.

use super::broker::{BrokerConfig, ConnectionStatus, MessageCallback, MqttBroker};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Internal broker entry with config and client
struct BrokerEntry {
    config: BrokerConfig,
    broker: Arc<RwLock<MqttBroker>>,
}

/// Manages multiple MQTT broker connections
#[derive(Clone)]
pub struct MqttManager {
    brokers: Arc<RwLock<HashMap<String, Arc<tokio::sync::Mutex<BrokerEntry>>>>>,
}

impl MqttManager {
    #[must_use] 
    pub fn new() -> Self {
        Self {
            brokers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Connect to a broker (creates connection if not exists)
    pub async fn connect(&self, config: BrokerConfig) -> Result<(), String> {
        let mut brokers = self.brokers.write().await;

        // Check if already connected
        if let Some(entry) = brokers.get(&config.id) {
            let entry_guard = entry.lock().await;
            let broker_guard = entry_guard.broker.read().await;
            let status = broker_guard.status().await;
            if matches!(status, ConnectionStatus::Connected | ConnectionStatus::Connecting) {
                log::info!("[MQTT Manager] Broker {} already connected", config.id);
                return Ok(());
            }
        }

        // Create new broker connection wrapped in Arc<RwLock<>>
        let broker = Arc::new(RwLock::new(MqttBroker::new(config.clone())));
        MqttBroker::connect(broker.clone()).await?;
        
        let entry = BrokerEntry {
            config,
            broker,
        };
        brokers.insert(entry.config.id.clone(), Arc::new(tokio::sync::Mutex::new(entry)));

        Ok(())
    }

    /// Disconnect from a broker
    pub async fn disconnect(&self, broker_id: &str) -> Result<(), String> {
        let mut brokers = self.brokers.write().await;

        if let Some(entry) = brokers.remove(broker_id) {
            let entry_guard = entry.lock().await;
            let mut broker_guard = entry_guard.broker.write().await;
            broker_guard.disconnect().await?;
        }

        Ok(())
    }

    /// Disconnect all brokers
    pub async fn disconnect_all(&self) -> Result<(), String> {
        let mut brokers = self.brokers.write().await;

        for (_, entry) in brokers.drain() {
            let entry_guard = entry.lock().await;
            let mut broker_guard = entry_guard.broker.write().await;
            let _ = broker_guard.disconnect().await;
        }

        Ok(())
    }

    /// Get connection status for a broker
    pub async fn status(&self, broker_id: &str) -> ConnectionStatus {
        let brokers = self.brokers.read().await;

        if let Some(entry) = brokers.get(broker_id) {
            let entry_guard = entry.lock().await;
            let broker_guard = entry_guard.broker.read().await;
            broker_guard.status().await
        } else {
            ConnectionStatus::Disconnected
        }
    }

    /// Check if config has changed for a broker
    pub async fn config_changed(&self, broker_id: &str, new_config: &BrokerConfig) -> bool {
        let brokers = self.brokers.read().await;
        
        if let Some(entry) = brokers.get(broker_id) {
            let entry_guard = entry.lock().await;
            let old = &entry_guard.config;
            old.url != new_config.url 
                || old.username != new_config.username 
                || old.password != new_config.password
        } else {
            true // No existing config means it's "changed"
        }
    }

    /// Get all broker IDs (connected or not)
    pub async fn all_broker_ids(&self) -> Vec<String> {
        let brokers = self.brokers.read().await;
        brokers.keys().cloned().collect()
    }

    /// Get status of all brokers
    pub async fn all_statuses(&self) -> Vec<(String, ConnectionStatus)> {
        let brokers = self.brokers.read().await;
        let mut statuses = Vec::new();

        for (id, entry) in brokers.iter() {
            let entry_guard = entry.lock().await;
            let broker_guard = entry_guard.broker.read().await;
            let status = broker_guard.status().await;
            statuses.push((id.clone(), status));
        }

        statuses
    }

    /// Subscribe to a topic on a broker
    pub async fn subscribe(
        &self,
        broker_id: &str,
        topic: &str,
        callback: MessageCallback,
    ) -> Result<(), String> {
        let brokers = self.brokers.read().await;

        let entry = brokers
            .get(broker_id)
            .ok_or_else(|| format!("Broker {broker_id} not connected"))?;

        let entry_guard = entry.lock().await;
        let broker_guard = entry_guard.broker.read().await;
        broker_guard.subscribe(topic, callback).await
    }

    /// Unsubscribe from a topic on a broker
    pub async fn unsubscribe(&self, broker_id: &str, topic: &str) -> Result<(), String> {
        let brokers = self.brokers.read().await;

        let entry = brokers
            .get(broker_id)
            .ok_or_else(|| format!("Broker {broker_id} not connected"))?;

        let entry_guard = entry.lock().await;
        let broker_guard = entry_guard.broker.read().await;
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

        let entry = brokers
            .get(broker_id)
            .ok_or_else(|| format!("Broker {broker_id} not connected"))?;

        let entry_guard = entry.lock().await;
        let broker_guard = entry_guard.broker.read().await;
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

        for (id, entry) in brokers.iter() {
            let entry_guard = entry.lock().await;
            let broker_guard = entry_guard.broker.read().await;
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
