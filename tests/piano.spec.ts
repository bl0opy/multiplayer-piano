import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// Each test uses its own room so parallel/retried runs never share a
// Durable Object with leftover players in it.
function roomUrl(name: string) {
  return `/?room=${name}-${test.info().workerIndex}-${test.info().retry}`;
}

/** Opens a page and fails loudly on any page error / console error. */
async function openPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  (page as any).__errors = errors;
  await page.goto(url);
  return page;
}

function errorsOf(page: Page): string[] {
  return (page as any).__errors ?? [];
}

/** Clears the name gate — nothing connects until a name is submitted. */
async function join(page: Page, name: string) {
  await page.locator("#name-input").fill(name);
  await page.locator("#join button").click();
  await expect(page.locator("#join")).toBeHidden();
}

test("no socket is opened until a name is submitted", async ({ context }) => {
  const page = await openPage(context, roomUrl("gate"));

  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));

  await expect(page.locator("#join")).toBeVisible();
  await page.waitForTimeout(500);
  expect(sockets.filter((u) => u.includes("/room/"))).toEqual([]);

  await join(page, "ada");
  await expect(page.locator("#status")).toContainText("you are ada");
});

test("the piano sample is served and decodes", async ({ context }) => {
  const page = await context.newPage();
  const audio: { url: string; status: number }[] = [];
  page.on("response", (r) => {
    // Match on content-type, not the path: in dev, Vite serves a `?url`
    // import as a JavaScript module whose URL still ends in .mp3.
    const type = r.headers()["content-type"] ?? "";
    if (type.startsWith("audio/")) audio.push({ url: r.url(), status: r.status() });
  });

  await page.goto(roomUrl("sample"));
  await join(page, "ada");

  // Runs in both dev and preview, so a base-path or asset-output regression
  // (the mp3 404ing under GitHub Pages' /multiplayer-piano/ prefix) fails here.
  await expect.poll(() => audio.length).toBeGreaterThan(0);
  expect(audio[0].status).toBe(200);

  // Decoding is what actually proves the bytes are usable audio.
  const seconds = await page.evaluate(async (url) => {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    return buf.duration;
  }, audio[0].url);
  expect(seconds).toBeGreaterThan(1);
  expect(seconds).toBeLessThan(3);
});

test("the room id is generated into the url when absent", async ({ context }) => {
  const page = await openPage(context, "/");

  await expect.poll(() => new URL(page.url()).searchParams.get("room")).not.toBeNull();
  await expect(page.locator("#room-label")).toContainText("room:");
});

test("the keyboard is centred on middle C", async ({ context }) => {
  const page = await openPage(context, roomUrl("layout"));

  const notes = await page.$$eval(".key", (els) =>
    els.map((e) => Number((e as HTMLElement).dataset.note)).sort((a, b) => a - b)
  );
  const whites = await page.$$eval(".key.white", (els) =>
    els.map((e) => Number((e as HTMLElement).dataset.note))
  );

  expect(Math.min(...notes)).toBe(48); // C3
  expect(Math.max(...notes)).toBe(71); // B4
  expect(whites).toHaveLength(14);

  // Middle C is the sample's native pitch, so it should sit in the centre of
  // the range — not at an edge, where most keys would resample far from 1x.
  expect(whites.indexOf(60)).toBe(7);
});

test("a note played by one client lights up on the other", async ({ browser }) => {
  // Two independent contexts = two separate browser profiles, which is
  // how a real second player connects.
  const a = await browser.newContext();
  const b = await browser.newContext();
  const url = roomUrl("duet");

  const pageA = await openPage(a, url);
  const pageB = await openPage(b, url);
  await join(pageA, "ada");
  await join(pageB, "grace");

  // Wait on the player count, not on the word "connected": both pages
  // reaching 2 is the real signal that the Durable Object has both sockets.
  await expect(pageA.locator("#status")).toContainText("2 players here");
  await expect(pageB.locator("#status")).toContainText("2 players here");

  const middleC = pageA.locator('[data-note="60"]');
  await middleC.dispatchEvent("mousedown");

  // B should see A's note land without B having touched anything.
  const remoteKey = pageB.locator('[data-note="60"]');
  await expect(remoteKey).toHaveClass(/active/);

  await middleC.dispatchEvent("mouseup");
  await expect(remoteKey).not.toHaveClass(/active/);

  expect(errorsOf(pageA)).toEqual([]);
  expect(errorsOf(pageB)).toEqual([]);

  await a.close();
  await b.close();
});

test("each player sees the other's named cursor", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const url = roomUrl("cursors");

  const pageA = await openPage(a, url);
  const pageB = await openPage(b, url);
  await join(pageA, "ada");
  await join(pageB, "grace");

  await expect(pageB.locator("#status")).toContainText("2 players here");

  await pageA.mouse.move(120, 140);
  await pageA.mouse.move(300, 220); // second move: throttling sends on a later frame

  const remoteCursor = pageB.locator("#cursor-layer .cursor");
  await expect(remoteCursor).toHaveCount(1);
  await expect(remoteCursor.locator(".cursor-label")).toHaveText("ada");

  // The cursor is positioned, not stuck at the origin.
  await expect
    .poll(async () => (await remoteCursor.getAttribute("style")) ?? "")
    .toContain("translate3d");

  // B's own cursor must not be drawn on B's screen.
  await pageB.mouse.move(400, 300);
  await expect(pageB.locator("#cursor-layer .cursor")).toHaveCount(1);

  expect(errorsOf(pageA)).toEqual([]);
  expect(errorsOf(pageB)).toEqual([]);

  await a.close();
  await b.close();
});

test("a disconnecting player's cursor and held note are cleaned up", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const url = roomUrl("leave");

  const pageA = await openPage(a, url);
  const pageB = await openPage(b, url);
  await join(pageA, "ada");
  await join(pageB, "grace");

  await expect(pageB.locator("#status")).toContainText("2 players here");

  await pageA.mouse.move(200, 200);
  await expect(pageB.locator("#cursor-layer .cursor")).toHaveCount(1);

  // A holds a note down and then vanishes without releasing it.
  await pageA.locator('[data-note="62"]').dispatchEvent("mousedown");
  await expect(pageB.locator('[data-note="62"]')).toHaveClass(/active/);

  await pageA.close();

  await expect(pageB.locator("#status")).toContainText("1 player here");
  await expect(pageB.locator("#cursor-layer .cursor")).toHaveCount(0);
  // The abandoned note must not sustain forever.
  await expect(pageB.locator('[data-note="62"]')).not.toHaveClass(/active/);

  await a.close();
  await b.close();
});
