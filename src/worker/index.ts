import { PianoRoom } from "./room";

export { PianoRoom };

export interface Env {
  PIANO_ROOMS: DurableObjectNamespace<PianoRoom>;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // /room/<roomId>/ws  ->  upgrade and hand off to that room's Durable Object.
    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,64})\/ws$/);
    if (match) {
      const roomId = match[1];
      // idFromName gives every request with the same room name the same
      // Durable Object instance, deterministically, with no coordination
      // service required.
      const id = env.PIANO_ROOMS.idFromName(roomId);
      const stub = env.PIANO_ROOMS.get(id);
      return stub.fetch(request);
    }

    // Everything else falls through to the static assets Vite built
    // (see vite.config.ts / [assets] in wrangler.toml) — the client HTML/JS/CSS.
    return env.ASSETS.fetch(request);
  },
};
