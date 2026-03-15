//! MQTT Broker Client
//!
//! Simple MQTT client implementation using mqtt-endpoint-tokio.

use mqtt_endpoint_tokio::mqtt_ep;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};

/// Configuration for MQTT reconnection with exponential backoff
#[derive(Debug, Clone)]
pub struct ReconnectConfig {
    /// Initial delay before first reconnection attempt (default: 1s)
    pub initial_delay: Duration,
    /// Maximum delay between attempts (default: 60s)
    pub max_delay: Duration,
    /// Multiplier applied to delay after each failure (default: 2.0)
    pub multiplier: f64,
    /// Maximum number of attempts, None for infinite (default: None)
    pub max_attempts: Option<usize>,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            multiplier: 2.0,
            max_attempts: None,
        }
    }
}

impl ReconnectConfig {
    /// Calculate the next delay after a failed attempt
    #[must_use] 
    pub fn next_delay(&self, current: Duration) -> Duration {
        let next_secs = current.as_secs_f64() * self.multiplier;
        let capped_secs = next_secs.min(self.max_delay.as_secs_f64());
        Duration::from_secs_f64(capped_secs)
    }
}

/// Type alias for client endpoint
type ClientEndpoint = mqtt_ep::endpoint::Endpoint<mqtt_ep::role::Client>;

/// Connection status for a broker
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

/// Parsed URL components
#[derive(Debug, Clone)]
struct ParsedUrl {
    host: String,
    port: u16,
    path: String,
    use_tls: bool,
    use_websocket: bool,
}

/// Broker configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerConfig {
    pub id: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl BrokerConfig {
    fn parse_url(&self) -> Result<ParsedUrl, String> {
        let url = &self.url;
        
        // Determine protocol
        let (use_tls, use_websocket, rest) = if let Some(stripped) = url.strip_prefix("wss://") {
            (true, true, stripped)
        } else if let Some(stripped) = url.strip_prefix("ws://") {
            (false, true, stripped)
        } else if let Some(stripped) = url.strip_prefix("mqtts://") {
            (true, false, stripped)
        } else if let Some(stripped) = url.strip_prefix("ssl://") {
            (true, false, stripped)
        } else if let Some(stripped) = url.strip_prefix("mqtt://") {
            (false, false, stripped)
        } else if let Some(stripped) = url.strip_prefix("tcp://") {
            (false, false, stripped)
        } else {
            // Default to mqtt:// if no scheme
            (false, false, url.as_str())
        };

        // Split host:port and path
        let (host_port, path) = if let Some(slash_idx) = rest.find('/') {
            (&rest[..slash_idx], rest[slash_idx..].to_string())
        } else {
            (rest, "/mqtt".to_string())
        };

        // Parse host and port
        let (host, port) = if let Some(colon_idx) = host_port.rfind(':') {
            let host = &host_port[..colon_idx];
            let port_str = &host_port[colon_idx + 1..];
            let port = port_str.parse::<u16>().map_err(|_| format!("Invalid port: {port_str}"))?;
            (host.to_string(), port)
        } else {
            // Default ports
            let default_port = match (use_tls, use_websocket) {
                (true, true) => 443,   // wss
                (false, true) => 80,   // ws
                (true, false) => 8883, // mqtts
                (false, false) => 1883, // mqtt
            };
            (host_port.to_string(), default_port)
        };

        Ok(ParsedUrl {
            host,
            port,
            path,
            use_tls,
            use_websocket,
        })
    }

    fn client_id(&self) -> String {
        format!(
            "microflow-{}",
            &uuid::Uuid::new_v4().to_string()[..8]
        )
    }
}

/// Incoming MQTT message
#[derive(Debug, Clone)]
pub struct MqttMessage {
    pub topic: String,
    pub payload: Vec<u8>,
    pub retain: bool,
}

/// Callback type for received messages
pub type MessageCallback = Arc<dyn Fn(MqttMessage) + Send + Sync>;

/// Internal state for the broker connection
struct BrokerState {
    status: ConnectionStatus,
    subscriptions: HashMap<String, MessageCallback>,
}

/// MQTT Broker client
pub struct MqttBroker {
    config: BrokerConfig,
    state: Arc<RwLock<BrokerState>>,
    endpoint: Option<Arc<ClientEndpoint>>,
    shutdown_tx: Option<mpsc::Sender<()>>,
    /// Configuration for automatic reconnection with exponential backoff
    reconnect_config: ReconnectConfig,
}

impl MqttBroker {
    #[must_use] 
    pub fn new(config: BrokerConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(BrokerState {
                status: ConnectionStatus::Disconnected,
                subscriptions: HashMap::new(),
            })),
            endpoint: None,
            shutdown_tx: None,
            reconnect_config: ReconnectConfig::default(),
        }
    }

    /// Create a new `MqttBroker` with custom reconnection configuration
    #[must_use] 
    pub fn with_reconnect_config(config: BrokerConfig, reconnect_config: ReconnectConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(BrokerState {
                status: ConnectionStatus::Disconnected,
                subscriptions: HashMap::new(),
            })),
            endpoint: None,
            shutdown_tx: None,
            reconnect_config,
        }
    }

    /// Connect to the MQTT broker
    /// 
    /// This method must be called on an Arc<`RwLock`<MqttBroker>> to enable
    /// automatic reconnection when the connection is lost.
    pub async fn connect(broker: Arc<RwLock<Self>>) -> Result<(), String> {
        // Use internal connect method for the actual connection
        {
            let mut broker_guard = broker.write().await;
            broker_guard.connect_internal().await?;
        }

        // Get the endpoint and config that was set by connect_internal
        let (endpoint, state, reconnect_config) = {
            let broker_guard = broker.read().await;
            let endpoint = broker_guard
                .endpoint
                .as_ref()
                .ok_or("Endpoint not set after connect_internal")?
                .clone();
            let state = broker_guard.state.clone();
            let reconnect_config = broker_guard.reconnect_config.clone();
            (endpoint, state, reconnect_config)
        };

        // Start receive loop
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        {
            let mut broker_guard = broker.write().await;
            broker_guard.shutdown_tx = Some(shutdown_tx);
        }

        let broker_clone = broker.clone();
        tokio::spawn(async move {
            Self::receive_loop(endpoint, state, shutdown_rx, broker_clone, reconnect_config).await;
        });

        Ok(())
    }

    /// Internal connect method for reconnection
    /// Same logic as `connect()` but without spawning `receive_loop`
    /// Returns after CONNACK received
    async fn connect_internal(&mut self) -> Result<(), String> {
        {
            let mut state = self.state.write().await;
            state.status = ConnectionStatus::Connecting;
        }

        let parsed = self.config.parse_url()?;
        log::info!(
            "[MQTT] Connecting to {}:{} (tls={}, ws={})",
            parsed.host,
            parsed.port,
            parsed.use_tls,
            parsed.use_websocket
        );

        let endpoint = ClientEndpoint::new(mqtt_ep::Version::V5_0);
        let addr = format!("{}:{}", parsed.host, parsed.port);

        // Connect based on transport type
        let attach_result = match (parsed.use_websocket, parsed.use_tls) {
            (true, true) => {
                self.connect_wss(&endpoint, &addr, &parsed.host, &parsed.path)
                    .await
            }
            (true, false) => {
                self.connect_ws(&endpoint, &addr, &parsed.host, &parsed.path)
                    .await
            }
            (false, true) => self.connect_tls(&endpoint, &addr, &parsed.host).await,
            (false, false) => self.connect_tcp(&endpoint, &addr).await,
        };

        if let Err(e) = attach_result {
            let mut state = self.state.write().await;
            state.status = ConnectionStatus::Error;
            return Err(e);
        }

        // Send CONNECT packet
        if let Err(e) = self.send_connect(&endpoint).await {
            let mut state = self.state.write().await;
            state.status = ConnectionStatus::Error;
            return Err(e);
        }

        // Wait for CONNACK
        match endpoint.recv().await {
            Ok(packet) => {
                if let mqtt_ep::packet::Packet::V5_0Connack(connack) = packet {
                    if connack.reason_code() == mqtt_ep::result_code::ConnectReasonCode::Success {
                        log::info!("[MQTT] Connected to broker {}", self.config.id);
                        let mut state = self.state.write().await;
                        state.status = ConnectionStatus::Connected;
                    } else {
                        let mut state = self.state.write().await;
                        state.status = ConnectionStatus::Error;
                        return Err(format!("CONNACK failed: {:?}", connack.reason_code()));
                    }
                } else {
                    let mut state = self.state.write().await;
                    state.status = ConnectionStatus::Error;
                    return Err("Unexpected packet, expected CONNACK".to_string());
                }
            }
            Err(e) => {
                let mut state = self.state.write().await;
                state.status = ConnectionStatus::Error;
                return Err(format!("Failed to receive CONNACK: {e}"));
            }
        }

        self.endpoint = Some(Arc::new(endpoint));

        Ok(())
    }

    async fn connect_tcp(&self, endpoint: &ClientEndpoint, addr: &str) -> Result<(), String> {
        let tcp_stream = mqtt_ep::transport::connect_helper::connect_tcp(addr, None)
            .await
            .map_err(|e| format!("TCP connect failed: {e}"))?;

        let transport = mqtt_ep::transport::TcpTransport::from_stream(tcp_stream);

        endpoint
            .attach(transport, mqtt_ep::endpoint::Mode::Client)
            .await
            .map_err(|e| format!("Failed to attach transport: {e}"))
    }

    async fn connect_tls(
        &self,
        endpoint: &ClientEndpoint,
        addr: &str,
        host: &str,
    ) -> Result<(), String> {
        let tls_stream =
            mqtt_ep::transport::connect_helper::connect_tcp_tls(addr, host, None, None)
                .await
                .map_err(|e| format!("TLS connect failed: {e}"))?;

        let transport = mqtt_ep::transport::TlsTransport::from_stream(tls_stream);

        endpoint
            .attach(transport, mqtt_ep::endpoint::Mode::Client)
            .await
            .map_err(|e| format!("Failed to attach TLS transport: {e}"))
    }

    async fn connect_ws(
        &self,
        endpoint: &ClientEndpoint,
        addr: &str,
        host: &str,
        path: &str,
    ) -> Result<(), String> {
        // Plain WS is not well supported by the library, upgrade to WSS
        // Most MQTT brokers use TLS anyway for security
        log::warn!("[MQTT] Plain WebSocket (ws://) requested, but using WSS for better compatibility");
        self.connect_wss(endpoint, addr, host, path).await
    }

    async fn connect_wss(
        &self,
        endpoint: &ClientEndpoint,
        addr: &str,
        host: &str,
        path: &str,
    ) -> Result<(), String> {
        let wss_stream =
            mqtt_ep::transport::connect_helper::connect_tcp_tls_ws(addr, host, path, None, None, None)
                .await
                .map_err(|e| format!("WSS connect failed: {e}"))?;

        let transport = mqtt_ep::transport::WebSocketTransport::from_tls_client_stream(wss_stream);

        endpoint
            .attach(transport, mqtt_ep::endpoint::Mode::Client)
            .await
            .map_err(|e| format!("Failed to attach WSS transport: {e}"))
    }

    async fn send_connect(&self, endpoint: &ClientEndpoint) -> Result<(), String> {
        let mut builder = mqtt_ep::packet::v5_0::Connect::builder()
            .client_id(self.config.client_id())
            .map_err(|e| format!("Invalid client ID: {e:?}"))?
            .keep_alive(60)
            .clean_start(true);

        if let (Some(username), Some(password)) = (&self.config.username, &self.config.password) {
            builder = builder
                .user_name(username)
                .map_err(|e| format!("Invalid username: {e:?}"))?
                .password(password.as_bytes().to_vec())
                .map_err(|e| format!("Invalid password: {e:?}"))?;
        }

        let connect = builder
            .build()
            .map_err(|e| format!("Failed to build CONNECT: {e:?}"))?;

        endpoint
            .send(connect)
            .await
            .map_err(Self::format_connection_error)
    }

    /// Receive loop that handles incoming MQTT packets
    /// 
    /// When a connection error occurs, this loop:
    /// 1. Updates status to Disconnected
    /// 2. Spawns the `reconnect_loop` to attempt automatic reconnection
    /// 
    /// # Requirements
    /// - 1.1: Initiates automatic reconnection when connection is lost
    async fn receive_loop(
        endpoint: Arc<ClientEndpoint>,
        state: Arc<RwLock<BrokerState>>,
        mut shutdown_rx: mpsc::Receiver<()>,
        broker: Arc<RwLock<MqttBroker>>,
        reconnect_config: ReconnectConfig,
    ) {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    log::info!("[MQTT] Receive loop shutdown");
                    break;
                }
                result = endpoint.recv() => {
                    match result {
                        Ok(packet) => {
                            Self::handle_packet(packet, &state).await;
                        }
                        Err(e) => {
                            log::error!("[MQTT] Receive error: {e}");
                            
                            // Update status to Disconnected before starting reconnection
                            {
                                let mut state_guard = state.write().await;
                                state_guard.status = ConnectionStatus::Disconnected;
                            }
                            
                            // Spawn reconnect_loop to attempt automatic reconnection (Requirement 1.1)
                            // Use spawn_reconnect_loop helper to avoid type cycle
                            spawn_reconnect_loop(broker.clone(), reconnect_config.clone(), state.clone());
                            
                            break;
                        }
                    }
                }
            }
        }
    }

    async fn handle_packet(packet: mqtt_ep::packet::Packet, state: &Arc<RwLock<BrokerState>>) {
        match packet {
            mqtt_ep::packet::Packet::V5_0Publish(publish) => {
                let topic = publish.topic_name().to_string();
                let payload = publish.payload().as_slice().to_vec();
                let retain = publish.retain();

                let state_guard = state.read().await;

                for (sub_topic, callback) in &state_guard.subscriptions {
                    if Self::topic_matches(sub_topic, &topic) {
                        let msg = MqttMessage {
                            topic: topic.clone(),
                            payload: payload.clone(),
                            retain,
                        };
                        callback(msg);
                    }
                }
            }
            mqtt_ep::packet::Packet::V5_0Pingresp(_) => {
                log::trace!("[MQTT] Received PINGRESP");
            }
            mqtt_ep::packet::Packet::V5_0Suback(suback) => {
                log::debug!("[MQTT] Received SUBACK: {suback:?}");
            }
            mqtt_ep::packet::Packet::V5_0Unsuback(unsuback) => {
                log::debug!("[MQTT] Received UNSUBACK: {unsuback:?}");
            }
            mqtt_ep::packet::Packet::V5_0Disconnect(disconnect) => {
                log::info!(
                    "[MQTT] Received DISCONNECT: {:?}",
                    disconnect.reason_code()
                );
                let mut state_guard = state.write().await;
                state_guard.status = ConnectionStatus::Disconnected;
            }
            _ => {
                log::debug!("[MQTT] Received packet: {packet:?}");
            }
        }
    }

    /// Simple MQTT topic matching (supports + and # wildcards)
    fn topic_matches(pattern: &str, topic: &str) -> bool {
        let pattern_parts: Vec<&str> = pattern.split('/').collect();
        let topic_parts: Vec<&str> = topic.split('/').collect();

        let mut p_idx = 0;
        let mut t_idx = 0;

        while p_idx < pattern_parts.len() && t_idx < topic_parts.len() {
            match pattern_parts[p_idx] {
                "#" => return true,
                "+" => {
                    p_idx += 1;
                    t_idx += 1;
                }
                part if part == topic_parts[t_idx] => {
                    p_idx += 1;
                    t_idx += 1;
                }
                _ => return false,
            }
        }

        p_idx == pattern_parts.len() && t_idx == topic_parts.len()
    }

    /// Disconnect from the broker
    pub async fn disconnect(&mut self) -> Result<(), String> {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(()).await;
        }

        if let Some(endpoint) = &self.endpoint {
            let disconnect = mqtt_ep::packet::v5_0::Disconnect::builder()
                .reason_code(mqtt_ep::result_code::DisconnectReasonCode::NormalDisconnection)
                .build()
                .map_err(|e| format!("Failed to build DISCONNECT: {e:?}"))?;

            let _ = endpoint.send(disconnect).await;
        }

        self.endpoint = None;

        let mut state = self.state.write().await;
        state.status = ConnectionStatus::Disconnected;
        state.subscriptions.clear();

        log::info!("[MQTT] Disconnected from broker {}", self.config.id);
        Ok(())
    }

    /// Get current connection status
    pub async fn status(&self) -> ConnectionStatus {
        self.state.read().await.status
    }

    /// Subscribe to a topic
    pub async fn subscribe(&self, topic: &str, callback: MessageCallback) -> Result<(), String> {
        let endpoint = self.endpoint.as_ref().ok_or("Not connected")?;

        // Acquire packet ID from the endpoint's internal pool
        let packet_id = endpoint
            .acquire_packet_id()
            .await
            .map_err(Self::format_connection_error)?;

        let sub_entry = mqtt_ep::packet::SubEntry::new(topic, mqtt_ep::packet::SubOpts::new())
            .map_err(|e| format!("Invalid topic: {e:?}"))?;

        let subscribe = mqtt_ep::packet::v5_0::Subscribe::builder()
            .packet_id(packet_id)
            .entries(vec![sub_entry])
            .build()
            .map_err(|e| format!("Failed to build SUBSCRIBE: {e:?}"))?;

        endpoint
            .send(subscribe)
            .await
            .map_err(Self::format_connection_error)?;

        let mut state = self.state.write().await;
        state.subscriptions.insert(topic.to_string(), callback);

        log::info!("[MQTT] Subscribed to topic: {topic}");
        Ok(())
    }

    /// Unsubscribe from a topic
    pub async fn unsubscribe(&self, topic: &str) -> Result<(), String> {
        let endpoint = self.endpoint.as_ref().ok_or("Not connected")?;

        // Acquire packet ID from the endpoint's internal pool
        let packet_id = endpoint
            .acquire_packet_id()
            .await
            .map_err(Self::format_connection_error)?;

        let unsubscribe = mqtt_ep::packet::v5_0::Unsubscribe::builder()
            .packet_id(packet_id)
            .entries(vec![topic.to_string()])
            .map_err(|e| format!("Invalid topic: {e:?}"))?
            .build()
            .map_err(|e| format!("Failed to build UNSUBSCRIBE: {e:?}"))?;

        endpoint
            .send(unsubscribe)
            .await
            .map_err(Self::format_connection_error)?;

        let mut state = self.state.write().await;
        state.subscriptions.remove(topic);

        log::info!("[MQTT] Unsubscribed from topic: {topic}");
        Ok(())
    }

    /// Publish a message to a topic
    pub async fn publish(&self, topic: &str, payload: &[u8], retain: bool) -> Result<(), String> {
        let endpoint = self.endpoint.as_ref().ok_or("Not connected")?;

        let publish = mqtt_ep::packet::v5_0::Publish::builder()
            .topic_name(topic)
            .map_err(|e| format!("Invalid topic: {e:?}"))?
            .payload(payload)
            .retain(retain)
            .build()
            .map_err(|e| format!("Failed to build PUBLISH: {e:?}"))?;

        endpoint
            .send(publish)
            .await
            .map_err(Self::format_connection_error)?;

        log::debug!("[MQTT] Published to topic: {topic}");
        Ok(())
    }

    fn format_connection_error(e: mqtt_ep::connection_error::ConnectionError) -> String {
        match e {
            mqtt_ep::connection_error::ConnectionError::NotConnected => "Not connected".to_string(),
            mqtt_ep::connection_error::ConnectionError::Transport(e) => {
                format!("Transport error: {e}")
            }
            mqtt_ep::connection_error::ConnectionError::Mqtt(e) => {
                format!("MQTT protocol error: {e:?}")
            }
            e => format!("Connection error: {e}"),
        }
    }

    /// Resubscribe to a single topic without re-registering the callback
    /// Used during reconnection when callbacks are already stored in state
    async fn resubscribe_topic(&self, topic: &str) -> Result<(), String> {
        let endpoint = self.endpoint.as_ref().ok_or("Not connected")?;

        // Acquire packet ID from the endpoint's internal pool
        let packet_id = endpoint
            .acquire_packet_id()
            .await
            .map_err(Self::format_connection_error)?;

        let sub_entry = mqtt_ep::packet::SubEntry::new(topic, mqtt_ep::packet::SubOpts::new())
            .map_err(|e| format!("Invalid topic: {e:?}"))?;

        let subscribe = mqtt_ep::packet::v5_0::Subscribe::builder()
            .packet_id(packet_id)
            .entries(vec![sub_entry])
            .build()
            .map_err(|e| format!("Failed to build SUBSCRIBE: {e:?}"))?;

        endpoint
            .send(subscribe)
            .await
            .map_err(Self::format_connection_error)?;

        log::info!("[MQTT] Resubscribed to topic: {topic}");
        Ok(())
    }

    /// Resubscribe to all previously subscribed topics
    /// Used after reconnection to restore subscriptions
    pub async fn resubscribe_all(&self) -> Result<(), String> {
        let state = self.state.read().await;
        let topics: Vec<String> = state.subscriptions.keys().cloned().collect();
        drop(state);

        for topic in topics {
            // Resubscribe without callback (already stored)
            self.resubscribe_topic(&topic).await?;
        }
        Ok(())
    }

    /// Reconnection loop with exponential backoff
    ///
    /// This function implements automatic reconnection when the MQTT connection is lost.
    /// It uses exponential backoff to avoid overwhelming the broker with reconnection attempts.
    ///
    /// # Arguments
    /// * `broker` - Arc-wrapped `RwLock` to the `MqttBroker` instance
    /// * `config` - `ReconnectConfig` with backoff parameters
    /// * `_state` - Arc-wrapped `RwLock` to the `BrokerState` (reserved for future use)
    ///
    /// # Requirements
    /// - 1.1: Initiates automatic reconnection when connection is lost
    /// - 1.6: Waits for current delay before retrying on failure
    /// - 1.9: Stops reconnecting when `max_attempts` is reached
    /// - 1.11: Resets delay to `initial_delay` on success (handled by new `receive_loop`)
    /// - 1.12: Logs each attempt with delay and attempt number
    async fn reconnect_loop(
        broker: Arc<RwLock<MqttBroker>>,
        config: ReconnectConfig,
        _state: Arc<RwLock<BrokerState>>,
    ) {
        let mut delay = config.initial_delay;
        let mut attempts = 0;

        loop {
            // Check max attempts before attempting reconnection (Requirement 1.9)
            if let Some(max) = config.max_attempts {
                if attempts >= max {
                    log::error!(
                        "[MQTT] Max reconnection attempts ({max}) reached, giving up"
                    );
                    break;
                }
            }

            // Log the reconnection attempt with delay and attempt number (Requirement 1.12)
            log::info!(
                "[MQTT] Reconnecting in {:?} (attempt {})",
                delay,
                attempts + 1
            );

            // Wait for the current delay before retrying (Requirement 1.6)
            tokio::time::sleep(delay).await;

            // Attempt reconnection
            let result = {
                let mut broker_guard = broker.write().await;
                broker_guard.connect_internal().await
            };

            match result {
                Ok(()) => {
                    log::info!("[MQTT] Reconnected successfully");

                    // Resubscribe to all topics (Requirement 1.10)
                    {
                        let broker_guard = broker.read().await;
                        if let Err(e) = broker_guard.resubscribe_all().await {
                            log::warn!("[MQTT] Failed to resubscribe: {e}");
                        }
                    }

                    // Spawn a new receive_loop to handle incoming packets
                    // This also resets the delay for the next disconnect (Requirement 1.11)
                    // Use spawn_receive_loop helper to avoid type cycle
                    spawn_receive_loop(broker.clone());

                    break;
                }
                Err(e) => {
                    log::warn!("[MQTT] Reconnection failed: {e}");
                    attempts += 1;
                    // Apply exponential backoff on failure (Requirement 1.7, 1.8)
                    delay = config.next_delay(delay);
                }
            }
        }
    }
}

/// Helper function to spawn the receive loop
/// This is a free function to break the type cycle between `receive_loop` and `reconnect_loop`
fn spawn_receive_loop(broker: Arc<RwLock<MqttBroker>>) {
    tokio::spawn(async move {
        let (endpoint, state, reconnect_config) = {
            let broker_guard = broker.read().await;
            let endpoint = if let Some(ep) = broker_guard.endpoint.as_ref() { ep.clone() } else {
                log::error!("[MQTT] No endpoint for receive loop");
                return;
            };
            let state = broker_guard.state.clone();
            let reconnect_config = broker_guard.reconnect_config.clone();
            (endpoint, state, reconnect_config)
        };

        // Create new shutdown channel for the new receive_loop
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        {
            let mut broker_guard = broker.write().await;
            broker_guard.shutdown_tx = Some(shutdown_tx);
        }

        MqttBroker::receive_loop(endpoint, state, shutdown_rx, broker.clone(), reconnect_config).await;
    });
}

/// Helper function to spawn the reconnect loop
/// This is a free function to break the type cycle between `receive_loop` and `reconnect_loop`
fn spawn_reconnect_loop(
    broker: Arc<RwLock<MqttBroker>>,
    config: ReconnectConfig,
    state: Arc<RwLock<BrokerState>>,
) {
    tokio::spawn(async move {
        MqttBroker::reconnect_loop(broker, config, state).await;
    });
}
