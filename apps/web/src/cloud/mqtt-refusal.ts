// Why a broker refused a connection, when it is something the user can act on.
//
// Both hosts connect with MQTT 5 only (`mqtt-client.ts`, `broker-transport.ts`,
// `browser-cloud-probe.ts`; the desktop's `src-tauri/src/mqtt/broker.rs`). A
// broker that speaks only MQTT 3.1.1 refuses such a connection in one of three
// ways, and two of them say so:
//
// - a 3.1.1 CONNACK with return code 1, "unacceptable protocol version"
//   (MQTT 3.1.1 §3.2.2.3). `mqtt.js` reads it as the reason code of an MQTT 5
//   CONNACK, and emits an `ErrorWithReasonCode` with `code` 1 ("Connection
//   refused: Unacceptable protocol version"). MQTT 5 has no CONNACK reason code
//   1, so on an MQTT 5 connection it can only be this.
// - an MQTT 5 CONNACK with reason code 0x84, "Unsupported Protocol Version"
//   (MQTT 5 §3.2.2.2). `mqtt.js` emits an `ErrorWithReasonCode` with `code`
//   132 ("Connection refused: Unsupported Protocol Version").
// - the connection closed without a CONNACK. `mqtt.js` emits no error, only
//   `close`; a broker closes a connection for many reasons, so nothing is
//   claimed about it here.
//
// The desktop host says the same words: `MQTT5_REQUIRED` in `broker.rs`, held
// to this one by `mqtt-refusal.test.ts`.

/** What the user is told about a broker that refused a connection for its
 *  protocol version. */
export const MQTT5_REQUIRED =
  "This broker does not speak MQTT 5. Microflow Studio needs an MQTT 5 broker — see the docs: /docs/troubleshooting/mqtt-cant-connect";

/** The CONNACK codes that refuse an MQTT 5 connection for its protocol
 *  version: 3.1.1's return code 1, and MQTT 5's reason code 0x84. */
const PROTOCOL_VERSION_REFUSALS: ReadonlySet<number> = new Set([0x01, 0x84]);

/**
 * What the user is to be told about `error`, an error an `mqtt.js` client
 * emitted, when it says something they can act on: {@link MQTT5_REQUIRED} for a
 * CONNACK that refused the connection for its protocol version. `undefined`
 * for anything else.
 *
 * `mqtt.js` words a refused CONNACK "Connection refused: …" and puts its code
 * on the error as a number; a socket error has a string `code` ("ECONNREFUSED")
 * and other wording. The error is read by its shape, not its class, so that a
 * stand-in for `mqtt.js` in a test is read the same way.
 */
export function brokerProblem(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message.startsWith("Connection refused:")) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "number" && PROTOCOL_VERSION_REFUSALS.has(code) ? MQTT5_REQUIRED : undefined;
}
