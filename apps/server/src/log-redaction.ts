/**
 * Query parameters whose values are credentials. The desktop app (Tauri) has
 * no cookies, so it authenticates the `/yjs/:flowId` WebSocket with
 * `?token=<bearer>` — browsers cannot set headers on a WebSocket upgrade.
 */
const SECRET_PARAMS = ["token", "access_token"];

const SECRET_QUERY = new RegExp(`([?&](?:${SECRET_PARAMS.join("|")})=)[^&\\s#]*`, "gi");

/**
 * Mask credential values in a logged URL or log line, keeping the parameter
 * name so the line still says a token was present.
 *
 * hono's `logger()` prints the full request URL including its query string,
 * so without this every desktop collaboration connect writes a live bearer
 * token to the server log.
 */
export function redactSecrets(line: string): string {
  return line.replace(SECRET_QUERY, "$1[redacted]");
}
