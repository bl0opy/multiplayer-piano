import { DurableObject } from "cloudflare:workers";

// A handful of distinguishable colors so each player's notes
// light up differently on everyone else's keyboard.
const PLAYER_COLORS = [
  "#f97316", "#22d3ee", "#a3e635", "#f472b6",
  "#818cf8", "#facc15", "#34d399", "#fb7185",
];

type NoteMessage = {
  type: "note_on" | "note_off";
  note: number; // MIDI note number
  velocity?: number;
  t: number; // client-side performance.now() timestamp, for latency debugging
};

type ClientInfo = {
  color: string;
  joinedAt: number;
};

/**
 * PianoRoom is the "conductor" for a single room. Cloudflare guarantees
 * exactly one live instance of this object per room ID, no matter how
 * many edge locations the connecting players are near — so every note
 * event passes through one consistent place and gets broadcast in a
 * single, well-defined order.
 *
 * It uses the WebSocket Hibernation API (ctx.acceptWebSocket) instead of
 * a plain `ws.accept()` loop. That means this object can be evicted from
 * memory while a connection is idle — Cloudflare wakes it back up and
 * restores `attachment` state the moment a message arrives — so an empty
 * room costs effectively nothing to keep "open."
 */
export class PianoRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    const existing = this.ctx.getWebSockets();
    const color = PLAYER_COLORS[existing.length % PLAYER_COLORS.length];
    const info: ClientInfo = { color, joinedAt: Date.now() };

    // acceptWebSocket (not ws.accept()) is what enables hibernation —
    // the runtime, not our code, keeps this socket alive between events.
    this.ctx.acceptWebSocket(server, [color]);
    server.serializeAttachment(info);

    // Tell the newcomer who else is already here, and tell everyone
    // else that a new player joined.
    server.send(JSON.stringify({ type: "welcome", color, players: existing.length + 1 }));
    this.broadcast(
      JSON.stringify({ type: "player_joined", color, players: existing.length + 1 }),
      server
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  // Called by the runtime when a message arrives on any hibernated
  // socket for this room — including waking the object back up if it
  // had gone to sleep.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let parsed: NoteMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    const info = ws.deserializeAttachment() as ClientInfo;
    const outgoing = JSON.stringify({
      type: parsed.type,
      note: parsed.note,
      velocity: parsed.velocity ?? 0.8,
      color: info.color,
      serverT: Date.now(),
    });

    this.broadcast(outgoing, ws);
  }

  async webSocketClose(ws: WebSocket) {
    const info = ws.deserializeAttachment() as ClientInfo | null;
    this.broadcast(
      JSON.stringify({ type: "player_left", color: info?.color }),
      ws
    );
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /** Send a message to every connected socket except (optionally) the sender. */
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

  // TODO (stretch goal): buffer note_on/note_off events and flush them
  // to D1 periodically, keyed by room + session start time, so a room
  // can be "replayed" after the fact. This is the natural next step
  // once the live path works.
}
