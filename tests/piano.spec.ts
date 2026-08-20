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

test("a single client reaches the room over a websocket", async ({ context }) => {
  const page = await openPage(context, roomUrl("solo"));

  await expect(page.locator("#status")).toContainText("connected", { timeout: 10_000 });
  expect(errorsOf(page)).toEqual([]);
});

test("the room id is generated into the url when absent", async ({ context }) => {
  const page = await openPage(context, "/");

  await expect.poll(() => new URL(page.url()).searchParams.get("room")).not.toBeNull();
  await expect(page.locator("#room-label")).toContainText("room:");
});

test("a note played by one client lights up on the other", async ({ browser }) => {
  // Two independent contexts = two separate browser profiles, which is
  // how a real second player connects.
  const a = await browser.newContext();
  const b = await browser.newContext();
  const url = roomUrl("duet");

  const pageA = await openPage(a, url);
  const pageB = await openPage(b, url);

  // Wait on the player count, not on the word "connected": once B joins,
  // A's status is overwritten by the player_joined message, so "connected"
  // is only briefly on screen. Both pages reaching 2 is the real signal
  // that the Durable Object has both sockets.
  await expect(pageA.locator("#status")).toContainText("2 player(s)");
  await expect(pageB.locator("#status")).toContainText("2 player(s)");

  const middleC = pageA.locator('[data-note="60"]');
  await middleC.dispatchEvent("mousedown");

  // B should see A's note land, in A's color, without B having touched anything.
  const remoteKey = pageB.locator('[data-note="60"]');
  await expect(remoteKey).toHaveClass(/active/);

  await middleC.dispatchEvent("mouseup");
  await expect(remoteKey).not.toHaveClass(/active/);

  expect(errorsOf(pageA)).toEqual([]);
  expect(errorsOf(pageB)).toEqual([]);

  await a.close();
  await b.close();
});
