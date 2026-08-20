# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev      # vite + @cloudflare/vite-plugin: client HMR AND the Worker/DO running in real workerd
npm run build    # vite build -> dist/client
npm run deploy   # build + wrangler deploy
npm run cf-typegen  # regenerate Worker types after changing wrangler.toml bindings

npm test                 # Playwright against the dev server
npm run test:preview     # same suite against the production build (PREVIEW=1)
npx playwright test -g "a note played"   # single test by title
```

No linter or formatter is configured. `npx tsc --noEmit` is the only type check.

Always run `npm run test:preview` as well as `npm test` when touching `vite.config.ts`,
`wrangler.toml`, or the build output — dev-server tests pass happily on a build that
emits assets to the wrong directory.

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

## Tests

`tests/piano.spec.ts` drives two independent browser contexts (= two browser profiles,
how a real second player connects) into one room and asserts a note played on A lights
up on B. Each test derives its own room id from the worker index and retry count so runs
never share a Durable Object with stale players in it.

Assert on the player count rather than the string "connected" when more than one client
is involved: `player_joined` overwrites the status line, so "connected" is only briefly
on screen and asserting on it is racy.

## Notes

- `vite.config.ts` sets `root: "src/client"` while `wrangler.toml` lives at the project root, so the plugin needs an explicit `configPath: "../../wrangler.toml"`. **Without it the plugin registers no Worker at all and fails silently** — the page still serves, but every `/room/<id>/ws` upgrade 404s and the client sits on "connecting…" forever. If you see that symptom, check `curl -s -o /dev/null -w '%{http_code}' localhost:5173/room/x/ws`: 426 means the Worker is wired up, 404 means it isn't. `/cdn-cgi/local/explorer/api/local/workers` returning `[]` confirms it.
- The plugin owns the layout inside `build.outDir`: assets to `dist/client`, Worker plus a generated `wrangler.json` to `dist/<worker-name>`. `outDir` is `../../dist` (relative to `root`) so those land where `wrangler.toml`'s `[assets]` expects. Don't point `outDir` straight at `dist/client` — you get `dist/client/client`.
- `deploy` uses the generated `dist/multiplayer_piano/wrangler.json`, not the root `wrangler.toml`, so the deployed Worker matches what Vite built.
- `.wrangler/` is local miniflare state — ignore it, don't commit it.
- README documents stretch goals (D1 session logging, Workers AI backing chords, latency compensation); the D1 binding is commented out in `wrangler.toml` and `room.ts` has the corresponding TODO.
