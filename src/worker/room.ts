import { DurableObject } from "cloudflare:workers";

// A handful of distinguishable colors so each player's notes and cursor
// read differently on everyone else's screen.
const PLAYER_COLORS = [
  "#f97316", "#22d3ee", "#a3e635", "#f472b6",
  "#818cf8", "#facc15", "#34d399", "#fb7185",
];

const MAX_NAME_LENGTH = 24;

/** Persisted per-socket via serializeAttachment — instance fields do NOT survive hibernation. */
type ClientInfo = {
  id: string;
  color: string;
  name: string;
  joinedAt: number;
};

type Incoming =
  | { type: "hello"; name?: string }
  | { type: "note_on" | "note_off"; note: number; velocity?: number }
  | { type: "cursor"; x: number; y: number };

function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Strip control characters so a name can't smuggle newlines into the UI.
  return raw.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * PianoRoom is the "conductor" for a single room. Cloudflare guarantees
 * exactly one live instance of this object per room ID, so every note and
 * cursor event passes through one place and is broadcast in a single,
 * well-defined order.
 *
 * It uses the WebSocket Hibernation API (ctx.acceptWebSocket), so this
 * object can be evicted from memory while connections are idle. All
 * per-connection state therefore lives in the socket's attachment, never
 * in instance fields.
 */
export class PianoRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    // Prefer a color nobody in the room is using before wrapping around.
    const taken = new Set(this.peers().map((p) => p.color));
    const color =
      PLAYER_COLORS.find((c) => !taken.has(c)) ??
      PLAYER_COLORS[this.ctx.getWebSockets().length % PLAYER_COLORS.length];

    const info: ClientInfo = {
      id: crypto.randomUUID(),
      color,
      name: "",
      joinedAt: Date.now(),
    };

    this.ctx.acceptWebSocket(server, [info.id]);
    server.serializeAttachment(info);

    // The newcomer needs the current roster to draw everyone already here.
    // Peers don't hear about them until they send `hello` with a name.
    server.send(
      JSON.stringify({
        type: "welcome",
        self: { id: info.id, color: info.color },
        players: this.peers(server),
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    // Ignore anything oversized rather than parsing it.
    if (message.length > 4096) return;

    let msg: Incoming;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    const info = ws.deserializeAttachment() as ClientInfo | null;
    if (!info) return;

    switch (msg.type) {
      case "hello": {
        const name = sanitizeName(msg.name) || "anonymous";
        const wasNamed = info.name !== "";
        const updated: ClientInfo = { ...info, name };
        ws.serializeAttachment(updated);

        // First hello is what makes this player visible to everyone else;
        // a later one is a rename.
        this.broadcast(
          JSON.stringify({
            type: wasNamed ? "player_renamed" : "player_joined",
            player: { id: updated.id, color: updated.color, name: updated.name },
            count: this.peers().length,
          }),
          ws
        );
        return;
      }

      case "note_on":
      case "note_off": {
        if (typeof msg.note !== "number" || !Number.isFinite(msg.note)) return;
        this.broadcast(
          JSON.stringify({
            type: msg.type,
            id: info.id,
            color: info.color,
            note: Math.trunc(msg.note),
            velocity: typeof msg.velocity === "number" ? msg.velocity : 0.8,
          }),
          ws
        );
        return;
      }

      case "cursor": {
        if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
        if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
        // Cursors are by far the highest-volume message here, so keep the
        // payload minimal and let clients fill in color/name from the roster.
        this.broadcast(
          JSON.stringify({ type: "cursor", id: info.id, x: msg.x, y: msg.y }),
          ws
        );
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    const info = ws.deserializeAttachment() as ClientInfo | null;
    if (!info) return;
    this.broadcast(
      JSON.stringify({
        type: "player_left",
        id: info.id,
        // The closing socket can still appear in getWebSockets(), so exclude
        // it rather than reporting a count that's one too high.
        count: this.peers(ws).length,
      }),
      ws
    );
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /** Named players currently connected, optionally excluding one socket. */
  private peers(exclude?: WebSocket) {
    const out: { id: string; color: string; name: string }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const info = ws.deserializeAttachment() as ClientInfo | null;
      if (!info || !info.name) continue;
      out.push({ id: info.id, color: info.color, name: info.name });
    }
    return out;
  }

  private broadcast(message: string, exclude?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(message);
      } catch {
        // Socket died without a close event firing yet — ignore.
      }
    }
  }
}
