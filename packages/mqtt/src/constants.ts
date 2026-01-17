/**
 * Regex pattern to validate MQTT URL format
 * Format: [<protocol>://]<host>[:<port>][/<path>]
 * Protocol defaults to wss, port defaults to 8883, path defaults to /mqtt
 */
export const mqttUrlRegex = /^(?:(ws|wss):\/\/)?([^\s/:]+)(?::(\d+))?(?:\/(.*))?$/;
