// Overarching types used across multiple modules

export const clients = ["app", "figma", "penpot"] as const;
export type Client = (typeof clients)[number];

export const ConnectionStatuses = ["connected", "disconnected", "connecting"] as const;
export type ConnectionStatus = (typeof ConnectionStatuses)[number];

export type MqttConfig = {
  url: string; // Format: [<protocol>://]<host>[:<port>][/<path>] - protocol defaults to wss, port defaults to 8883, path defaults to /mqtt
  username?: string;
  password?: string;
  uniqueId: string;
};
