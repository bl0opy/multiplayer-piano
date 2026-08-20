import { defineConfig } from "@playwright/test";

// PREVIEW=1 runs the suite against the production build (vite preview,
// serving dist/) instead of the dev server. Worth having: a build that
// emits assets to the wrong directory passes every dev-server test and
// still ships broken.
const preview = !!process.env.PREVIEW;
const port = preview ? 4173 : 5173;

export default defineConfig({
  testDir: "./tests",
  timeout: 20_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: preview ? "npm run build && npm run preview" : "npm run dev",
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
