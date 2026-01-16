import mqtt, { type IClientPublishOptions, type OnMessageCallback } from "mqtt";
import type { MqttConfig, Client, ConnectionStatus } from "./types";
import { parseMqttUrl } from "./url-parser";

type Subscription = {
  callback: OnMessageCallback;
  options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties;
};

export class MqttClientManager {
  private client: mqtt.MqttClient | undefined;
  private config: MqttConfig | null = null;
  private subscriptions = new Map<string, Subscription>();
  private connectedClients = new Map<Client, ConnectionStatus>();
  private appName: Client = "app";
  private statusHandlers: Set<(status: ConnectionStatus) => void> = new Set();
  private connectedClientsHandlers: Set<
    (clients: Array<{ appName: Client; status: ConnectionStatus }>) => void
  > = new Set();

  /**
   * Subscribe to connection status changes
   */
  onStatusChange(handler: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to connected clients changes
   */
  onConnectedClientsChange(
    handler: (clients: Array<{ appName: Client; status: ConnectionStatus }>) => void
  ): () => void {
    this.connectedClientsHandlers.add(handler);
    return () => {
      this.connectedClientsHandlers.delete(handler);
    };
  }

  private notifyStatusChange(status: ConnectionStatus) {
    this.statusHandlers.forEach((handler) => handler(status));
  }

  private notifyConnectedClientsChange() {
    const clients = Array.from(this.connectedClients.entries()).map(
      ([appName, status]) => ({
        appName,
        status,
      })
    );
    this.connectedClientsHandlers.forEach((handler) => handler(clients));
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    if (this.client?.connected) return "connected";
    if (this.client) return "connecting";
    return "disconnected";
  }

  /**
   * Get current config
   */
  getConfig(): MqttConfig | null {
    return this.config;
  }

  /**
   * Get current app name
   */
  getAppName(): Client {
    return this.appName;
  }

  /**
   * Get connected clients
   */
  getConnectedClients(): Array<{ appName: Client; status: ConnectionStatus }> {
    return Array.from(this.connectedClients.entries()).map(
      ([appName, status]) => ({
        appName,
        status,
      })
    );
  }

  /**
   * Disconnect the MQTT client
   */
  disconnect(): void {
    this.client?.removeAllListeners();
    this.client?.end(true);
    this.client = undefined;
    this.notifyStatusChange("disconnected");
  }

  /**
   * Unsubscribe from a topic
   */
  unsubscribe(topic: string): void {
    this.subscriptions.delete(topic);
    if (this.client?.connected) {
      console.debug("[MQTT] <unsubscribe>", topic);
      this.client.unsubscribeAsync(topic).catch(console.error);
    }
  }

  /**
   * Subscribe to a topic
   */
  subscribe(
    topic: string,
    callback: OnMessageCallback,
    options?: mqtt.IClientSubscribeOptions | mqtt.IClientSubscribeProperties
  ): () => void {
    this.subscriptions.set(topic, { callback, options });

    // Only subscribe if client is connected
    if (this.client?.connected) {
      console.debug("[MQTT] <subscribe>", this.client?.connected, topic, options);
      this.client.subscribeAsync(topic, options);
    }

    return () => {
      this.unsubscribe(topic);
    };
  }

  /**
   * Publish a message to a topic
   */
  publish(
    topic: string,
    payload: string,
    options?: IClientPublishOptions
  ): void {
    // Only publish if client is connected
    if (!this.client?.connected) {
      console.warn("[MQTT] <publish> Client not connected", topic);
      return;
    }

    console.debug("[MQTT] <publish>", topic, payload, options);
    this.client.publishAsync(topic, payload, options).catch((error) => {
      console.error("[MQTT] <publish>", error);
    });
  }

  /**
   * Resubscribe to all topics (used after reconnection)
   */
  private async resubscribe(): Promise<void> {
    if (!this.config || !this.appName || !this.client?.connected) {
      return;
    }

    const statusTopic = `microflow/v1/${this.config.uniqueId}/+/status`;

    for (const [topic, { options }] of Array.from(this.subscriptions)) {
      if (topic === statusTopic) continue;

      this.client.subscribeAsync(topic, options).catch((error) => {
        console.error("[MQTT] <resubscribe error>", topic, error);
      });
    }
  }

  /**
   * Escape regex special characters for topic matching
   */
  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Handle incoming MQTT messages
   */
  private handleMessage = (topic: string, payload: Buffer, packet: any) => {
    Array.from(this.subscriptions.keys()).forEach((subscription) => {
      const regexp = this.escapeRegExp(subscription)
        .replace(/\\\+/g, "\\S+")
        .replace(/\\#/, "\\S+");
      if (!topic.match(regexp)) return;

      try {
        const { callback } = this.subscriptions.get(subscription)!;
        callback?.(topic, payload, packet);
      } catch {
        console.error("Error in callback for topic", {
          topic,
          subscription,
        });
      }
    });
  };

  /**
   * Handle status messages from other clients
   */
  private handleStatusMessage = (topic: string, payload: Buffer) => {
    const from = topic.split("/")[3]?.toString() ?? "[UNKNOWN_CLIENT]";
    if (from === this.appName) return; // No need to get status from self

    this.connectedClients.set(
      from as Client,
      payload.toString() as "connected" | "disconnected"
    );
    this.notifyConnectedClientsChange();
  };

  /**
   * Connect to MQTT broker
   */
  async connect(configParam: MqttConfig, appName: Client): Promise<void> {
    this.config = configParam;
    this.appName = appName;

    if (this.client) {
      this.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    this.notifyStatusChange("connecting");

    // Parse the URL string into connection components
    const { protocol, host, port, path } = parseMqttUrl(configParam.url);
    const clientId = `microflow_${appName}_${
      configParam.uniqueId
    }_${Date.now().toString(36)}`;

    console.debug("[MQTT] <connect> Parsed URL:", {
      input: configParam.url,
      protocol,
      host,
      port,
      path,
      clientId,
    });

    // Build connection options
    const connectionOptions: mqtt.IClientOptions = {
      protocol: protocol === "wss" ? "wss" : protocol === "ws" ? "ws" : "wss",
      hostname: host,
      port: port,
      path: path,
      ...(configParam.username && { username: configParam.username }),
      ...(configParam.password && { password: configParam.password }),
      clientId,
      // For WSS connections, ensure proper SSL handling
      ...(protocol === "wss" || protocol === "ws"
        ? {
            // Allow self-signed certificates (common for public brokers)
            rejectUnauthorized: false,
          }
        : {}),
      will: {
        topic: `microflow/v1/${configParam.uniqueId}/${appName}/status`,
        retain: true,
        qos: 2,
        properties: {
          willDelayInterval: 0,
        },
        payload: new Uint8Array([
          100, 105, 115, 99, 111, 110, 110, 101, 99, 116, 101, 100,
        ]) as Buffer,
      },
    };

    console.debug("[MQTT] <connect>", configParam, appName, connectionOptions);
    this.client = mqtt.connect(connectionOptions);

    // Set up event handlers
    this.client
      .on("connect", async () => {
        console.debug("[MQTT] <connect>", this.config?.uniqueId);
        await this.resubscribe();
        this.subscribe(
          `microflow/v1/${this.config?.uniqueId ?? "[NO_UNIQUE_ID_SET]"}/+/status`,
          this.handleStatusMessage
        );
        this.publish(
          `microflow/v1/${
            this.config?.uniqueId ?? "[NO_UNIQUE_ID_SET]"
          }/${appName}/status`,
          "connected",
          {
            retain: true,
            qos: 2,
          }
        );
        this.notifyStatusChange("connected");
      })
      .on("reconnect", () => {
        console.debug("[MQTT] <reconnect>");
        this.notifyStatusChange("connecting");
      })
      .on("error", (error) => {
        console.debug("[MQTT] <error>", error);
        this.notifyStatusChange("disconnected");
      })
      .on("offline", () => {
        console.debug("[MQTT] <offline>");
        this.notifyStatusChange("disconnected");
      })
      .on("disconnect", (error) => {
        console.debug("[MQTT] <disconnect>", error);
        this.notifyStatusChange("disconnected");
      })
      .on("close", () => {
        console.debug("[MQTT] <close>");
        this.notifyStatusChange("disconnected");
      })
      .on("end", () => {
        console.debug("[MQTT] <end>");
        this.notifyStatusChange("disconnected");
      })
      .on("message", this.handleMessage);
  }
}
