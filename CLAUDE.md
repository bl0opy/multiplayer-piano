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

npm run build:pages      # client-only build for GitHub Pages (no Worker)
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

Each connection gets a server-assigned `id` (`crypto.randomUUID()`) plus a color picked to avoid collisions with players already in the room. **The `id` is the player identity** — it keys voices, cursors, and join/leave; color is presentation only. Names arrive later via `hello` and are sanitized server-side (control chars stripped, capped at 24 chars).

A socket is invisible to other players until its first `hello`, so `peers()` filters on a non-empty name. That's what lets a client sit on the name gate without appearing in anyone's roster.

Protocol, client → server: `hello{name}`, `note_on`/`note_off{note,velocity}`, `cursor{x,y}`. Server → client: `welcome{self,players}`, `player_joined`/`player_renamed{player,count}`, `player_left{id,count}`, `note_on`/`note_off{id,color,note}`, `cursor{id,x,y}`. Cursor messages deliberately carry no color or name — they're the highest-volume message, so clients look those up in their own roster.

**`src/client/`** — vanilla TS, no framework.

- `main.ts` — the name gate, the socket (exponential-backoff reconnect, 500ms → 8s), the room ID (`?room=` param, generated + `replaceState`d if absent), and the `peers` roster every other module reads from. **Nothing connects until the join form is submitted**: that submit is also the user gesture that unlocks the AudioContext, so don't move `connect()` earlier or the first note is silent.
- `piano.ts` — DOM keyboard, key highlighting, computer-keyboard mapping. Audio is delegated to `sampler.ts`.
- `sampler.ts` — sample playback. One recorded middle C (`audio/piano-c4.mp3`) pitch-shifted by `playbackRate` for every other key, so resampling shortens higher notes as well as raising them. Imported with `?url` so Vite rewrites the path for whatever base the site is served under — a plain `/audio/...` string would 404 under GitHub Pages' `/multiplayer-piano/` prefix.
- `cursors.ts` — remote cursor rendering. Positions are viewport *fractions*, not pixels, so they map across screen sizes; sends are throttled to ~40ms and coalesced onto animation frames.
- `config.ts` — resolves the WebSocket URL. Same-origin by default; `VITE_WORKER_ORIGIN` points it at a remote Worker for the GitHub Pages build.

Player names are untrusted input on top of being sanitized server-side — set them with `textContent`, never `innerHTML` (see `createCursor`).

Voices are keyed `` `${note}:${color}` `` so two players holding the same note are two independent oscillators and one `note_off` releases only the right one. Preserve that key shape if you touch voice handling.

The keyboard is DOM divs, not canvas: two octaves from MIDI 48 (C3 to B4), white keys laid out in flow and black keys absolutely positioned by percentage off the white-key index. The range is deliberately centred on middle C — the sample's native pitch — so keys resample between 0.5x and 2x rather than the 1x-4x a C4-upward layout forced; past ~2x the tone gets thin and short. The computer-keyboard row (`TYPING_START_NOTE`) starts at middle C independently of the on-screen range. Both share `data-note`, and `highlightKey` sets `style.backgroundColor` directly — colors are inline, not CSS classes.

## Tests

`tests/piano.spec.ts` drives two independent browser contexts (= two browser profiles,
how a real second player connects) into one room and asserts a note played on A lights
up on B. Each test derives its own room id from the worker index and retry count so runs
never share a Durable Object with stale players in it.

Assert on the player count rather than the string "connected" when more than one client
is involved: `player_joined` overwrites the status line, so "connected" is only briefly
on screen and asserting on it is racy.

## The piano sample

`src/client/audio/piano-c4.mp3` is derived from `sound/middle-c.mp3` (the 42s
original, kept as the source). Only the first ~1.8s of that file is a piano
note — after ~2.05s a sustained pad fades in and cycles every ~6s — and the
note itself doesn't start until 0.214s. Regenerate with:

```bash
ffmpeg -i sound/middle-c.mp3 -ac 1 -ar 44100 /tmp/full.wav
ffmpeg -ss 0.2140 -t 1.826 -i /tmp/full.wav -af "afade=t=out:st=1.676:d=0.15" -b:a 96k src/client/audio/piano-c4.mp3
```

Trim on the decoded WAV, not the mp3: `-ss` on a compressed stream snaps to a
frame boundary and lands the attack tens of ms late.

Known limitation: one sample covers the whole keyboard. Centring the range on
middle C keeps playback within 0.5x-2x, which is acceptable, but the top notes
are still shorter and thinner than the bottom. Adding samples for C3/C5 and
picking the nearest per note is the fix.

## Hosting

Two deployment targets, and they are not equivalent:

- `npm run deploy` — Worker serves both the API and the client from one origin. This is the simple path.
- `npm run build:pages` + `.github/workflows/pages.yml` — static client on GitHub Pages, WebSocket cross-origin to the Cloudflare Worker. Pages cannot run a Worker or Durable Object, so the Worker still has to be deployed separately; the workflow hard-fails if the `WORKER_ORIGIN` repo variable is unset, since the alternative is a silently hanging client.

`vite.config.pages.ts` deliberately omits the cloudflare plugin — it is a client-only build.

## Notes

- `vite.config.ts` sets `root: "src/client"` while `wrangler.toml` lives at the project root, so the plugin needs an explicit `configPath: "../../wrangler.toml"`. **Without it the plugin registers no Worker at all and fails silently** — the page still serves, but every `/room/<id>/ws` upgrade 404s and the client sits on "connecting…" forever. If you see that symptom, check `curl -s -o /dev/null -w '%{http_code}' localhost:5173/room/x/ws`: 426 means the Worker is wired up, 404 means it isn't. `/cdn-cgi/local/explorer/api/local/workers` returning `[]` confirms it.
- The plugin owns the layout inside `build.outDir`: assets to `dist/client`, Worker plus a generated `wrangler.json` to `dist/<worker-name>`. `outDir` is `../../dist` (relative to `root`) so those land where `wrangler.toml`'s `[assets]` expects. Don't point `outDir` straight at `dist/client` — you get `dist/client/client`.
- `deploy` uses the generated `dist/multiplayer_piano/wrangler.json`, not the root `wrangler.toml`, so the deployed Worker matches what Vite built.
- `.wrangler/` is local miniflare state — ignore it, don't commit it.
- README documents stretch goals (D1 session logging, Workers AI backing chords, latency compensation); the D1 binding is commented out in `wrangler.toml` and `room.ts` has the corresponding TODO.
