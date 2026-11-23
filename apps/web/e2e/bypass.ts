// Cloudflare puts a bot challenge in front of microflow.tech and the server's
// WebSocket for datacenter IPs, GitHub's runners included. A Cloudflare custom
// rule skips the challenge for requests that carry this header with the secret
// value, so the live suite sends it when `SMOKE_BYPASS_TOKEN` is set.
export const BYPASS_HEADER = "x-microflow-smoke";

export function bypassHeaders(): Record<string, string> {
  const token = process.env.SMOKE_BYPASS_TOKEN;
  return token ? { [BYPASS_HEADER]: token } : {};
}
