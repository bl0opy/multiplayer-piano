import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// Absolute origin baked into the Open Graph tags in index.html. The Worker
// serves the client from its own origin, so that's the default here; the
// GitHub Pages build overrides it in vite.config.pages.ts.
process.env.VITE_SITE_URL ??= "https://multiplayer-piano.multiplayer-piano.workers.dev";

export default defineConfig({
  // `root` is the client app, but wrangler.toml lives at the project root.
  // Without an explicit configPath the plugin looks for it under `root`,
  // finds nothing, and silently registers no Worker at all — which makes
  // /room/<id>/ws 404 instead of upgrading to a WebSocket.
  plugins: [cloudflare({ configPath: "../../wrangler.toml" })],
  root: "src/client",
  // The plugin owns the layout *inside* outDir: static assets go to
  // dist/client, the Worker plus a generated wrangler.json to
  // dist/<worker-name>. Point outDir at the project root's dist so those
  // land where wrangler.toml's [assets] directory expects them.
  build: { outDir: "../../dist", emptyOutDir: true },
});
