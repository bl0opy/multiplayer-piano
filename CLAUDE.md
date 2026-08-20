# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev      # vite + @cloudflare/vite-plugin: client HMR AND the Worker/DO running in real workerd
npm run build    # vite build -> dist/client
npm run deploy   # build + wrangler deploy
npm run cf-typegen  # regenerate Worker types after changing wrangler.toml bindings
```

No test suite, linter, or formatter is configured. `npx tsc --noEmit` is the only type check.

Not a git repo yet — `git init` before committing.

## Architecture

Three layers, one message type flowing between them: `{ type: "note_on" | "note_off", note, velocity }`.

**`src/worker/index.ts`** — the only router. `/room/<id>/ws` matches `[a-zA-Z0-9_-]{1,64}`, resolves `env.PIANO_ROOMS.idFromName(roomId)`, and hands the upgrade to that stub. Everything else falls through to `env.ASSETS` (the built `dist/client`).

**`src/worker/room.ts`** — `PianoRoom`, one Durable Object instance per room ID, the single ordering authority for the room. Two things constrain how you edit it:

- It uses the **WebSocket Hibernation API** (`ctx.acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`webSocketError` handlers), not `ws.accept()` + an event loop. Per-connection state must go through `serializeAttachment`/`deserializeAttachment` — instance fields do NOT survive eviction. Adding a constructor-held `Map` of connections is the classic wrong move here; use `ctx.getWebSockets()` instead.
- `broadcast()` excludes the sender, which is what makes the client's local echo non-duplicating. If you ever broadcast to all sockets, remove the client-side local echo too or notes double-trigger for the player.

Player color is assigned by `existing.length % PLAYER_COLORS.length` at connect time and is the only player identity in the protocol — it keys voices, key highlights, and join/leave messages. There is no user ID.

**`src/client/`** — vanilla TS, no framework. `main.ts` owns the socket (exponential-backoff reconnect, 500ms → 8s) and the room ID (`?room=` param, generated + `replaceState`d if absent). `piano.ts` owns everything else: Web Audio synth, DOM keyboard, computer-keyboard mapping.

Voices are keyed `` `${note}:${color}` `` so two players holding the same note are two independent oscillators and one `note_off` releases only the right one. Preserve that key shape if you touch voice handling.

The keyboard is DOM divs, not canvas: 2 octaves from MIDI 60, white keys laid out in flow and black keys absolutely positioned by percentage off the white-key index. Both share `data-note`, and `highlightKey` sets `style.backgroundColor` directly — colors are inline, not CSS classes.

## Notes

- `vite.config.ts` sets `root: "src/client"`, so client-relative paths resolve from there while `wrangler.toml` `main` points at `src/worker/index.ts`.
- `src/client/.wrangler/` is local miniflare state — ignore it, don't commit it.
- README documents stretch goals (D1 session logging, Workers AI backing chords, latency compensation); the D1 binding is commented out in `wrangler.toml` and `room.ts` has the corresponding TODO.
