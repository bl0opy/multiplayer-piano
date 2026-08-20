import { defineConfig } from "vite";

// Client-only build for GitHub Pages.
//
// Pages is static hosting: it cannot run the Worker or the Durable Object,
// so the cloudflare plugin is deliberately absent here. The rooms still work
// because the client opens its WebSocket against VITE_WORKER_ORIGIN — the
// Worker you deployed with `npm run deploy` — instead of its own origin.
//
// BASE must match how Pages serves the site: "/<repo>/" for a project page
// (the default), or "/" for a user page or custom domain.
export default defineConfig({
  root: "src/client",
  base: process.env.PAGES_BASE ?? "/multiplayer-piano/",
  build: { outDir: "../../dist/pages", emptyOutDir: true },
});
