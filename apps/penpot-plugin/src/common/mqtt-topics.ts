/** Encode a Penpot token path for use in MQTT topics (slashes → dashes). */
export const shortTokenId = (path: string) => path.replace(/\//g, "-");

/** Decode an MQTT-safe token ID back to a Penpot token path (dashes → slashes). */
export const fullTokenId = (short: string) => short.replace(/-/g, "/");
