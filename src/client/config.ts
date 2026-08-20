// Where the Durable Object lives.
//
// Served from Cloudflare (npm run deploy), the Worker is the same origin
// that served this page, so the default empty value is correct.
//
// Served from GitHub Pages, there is no Worker on that origin — Pages is
// static hosting only. Point VITE_WORKER_ORIGIN at the deployed Worker
// (e.g. https://multiplayer-piano.<subdomain>.workers.dev) at build time
// and the client will open its WebSocket cross-origin instead.
const CONFIGURED = (import.meta.env.VITE_WORKER_ORIGIN ?? "").trim();

export function roomSocketUrl(roomId: string): string {
  if (CONFIGURED) {
    const url = new URL(CONFIGURED);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/room/${roomId}/ws`;
    return url.toString();
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}/room/${roomId}/ws`;
}
