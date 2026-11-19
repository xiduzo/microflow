// Which broker URLs a browser can connect to. No imports, so everything that
// opens a broker connection — the CloudPerformer, the reachability probe, the
// Connection Console's transport — and the host-limitation wording
// (`nodes/_base/browser-support.ts`) can ask the same question.

/** Browsers cannot open a raw MQTT/TCP socket — only MQTT-over-WebSocket. Also
 *  false for the half-typed URL a config field holds while it is being edited,
 *  on which `mqtt.connect` throws "Missing protocol". A URL that passes can
 *  still fail to open (a space, an impossible port): connect sites must not let
 *  that throw escape. */
export function isBrowserReachableBroker(url: string): boolean {
  return /^wss?:\/\//i.test(url.trim());
}
