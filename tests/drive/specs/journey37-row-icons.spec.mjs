/**
 * P37 — the row icon says what is happening now (SPEC 256-262).
 *
 * The dot left of a project's name had three marks added by three different afternoons and never
 * ranked. This drives the two the 2026-08-09 review asked for — the prompt-cache hour as a bar
 * under the icon, and the marching dots for a turn running somewhere else — against the ladder they
 * were fitted into.
 *
 * `/api/activity` is STUBBED, because the facts under test (`running`, `cacheAt`, `ttlMs`) arrive
 * only in that response: faking it fakes the input and not the answer. One record is re-stubbed per
 * test rather than four at once, so the spec does not depend on how many records the fixture or an
 * earlier spec happens to leave on screen.
 *
 * Fails against the pre-build client at the first assertion: `.tree-dot.working` does not exist.
 */

import { expect, test } from "@playwright/test";

const MIN = 60_000;
const HOUR = 60 * MIN;

const live = async (page) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
};

/** The record paths the tree is drawing right now — read from the request, never from a snapshot. */
const visibleRecords = async (page) => {
  const rows = page.locator(".tree-item[data-record]");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  return new Set(await rows.evaluateAll((els) => els.map((e) => e.dataset.record)));
};

/**
 * Give ONE record on screen the sessions a test needs, and hand back its path.
 *
 * `make(base)` is called with a timestamp fixed at the FIRST request and reused on every later one,
 * so a window really does age across a test instead of being refilled by each poll — which is the
 * whole claim of the cache bar.
 */
const stubOne = async (page, visible, make) => {
  const picked = {};
  let base = null;
  await page.route("**/api/activity", async (route) => {
    const asked = JSON.parse(route.request().postData() ?? "{}").records ?? [];
    const known = [...asked].filter((p) => visible.has(p)).sort();
    picked.path = known[0];
    base ??= Date.now();
    const body = { answered: known };
    if (picked.path !== undefined) body[picked.path] = make(base);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  return picked;
};

/** Load, stub against what is on screen, reload into the stub. */
const loadStubbed = async (page, make) => {
  await live(page);
  const picked = await stubOne(page, await visibleRecords(page), make);
  const activityResponse = page.waitForResponse("**/api/activity");
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await activityResponse;
  return picked;
};

const dotOf = (page, path) => page.locator(`.tree-item[data-record="${path}"] .tree-dot`);

/** A session the server would answer with. Everything the four states are built out of. */
const session = (id, over) => ({
  id,
  store: "s",
  mtime: Date.now(),
  lastReply: 0,
  lastEnded: 0,
  lastTyped: 0,
  cacheAt: null,
  ttlMs: null,
  running: false,
  ...over,
});

/** Exactly one of the four is ever drawn — the assertion that makes "a ladder" mean anything. */
const stateOf = async (dot) =>
  dot.evaluate((el) => ["working", "unread", "new"].filter((c) => el.classList.contains(c)));

test("a turn running elsewhere marches, and wears no bar even with a warm window", async ({ page }) => {
  await page.clock.install();
  const { path } = await loadStubbed(page, (base) => [
    // Both facts at once: a reply is waiting here AND a turn is running. Working outranks unread,
    // because "wait rather than act" is the more urgent instruction (SPEC 256). `lastEnded` is read
    // at REQUEST time — the unread watermark is written on this device's first load, so a timestamp
    // taken before that would be below it and the letter would never have been true to begin with.
    session("live-one", { running: true, lastEnded: Date.now(), lastReply: Date.now(), cacheAt: base, ttlMs: HOUR }),
  ]);
  const dot = dotOf(page, path);
  await expect(dot).toHaveClass(/\bworking\b/, { timeout: 20_000 });
  expect(await stateOf(dot)).toEqual(["working"]); // and NOT the letter, though the letter was true
  await expect(dot.locator(".march")).toHaveCount(3);
  // No bar under working: the window is being pushed FORWARD by the turn, not spent (SPEC 258).
  await expect(dot.locator(".cache-track")).toHaveCount(0);
  await expect(dot.locator(".cache-fill")).toHaveCount(0);
  // Two-sided: the dots are really animating, not three static pips that happen to be there.
  const running = await dot.locator(".march").first().evaluate((el) => {
    const a = el.getAnimations()[0];
    return a === undefined ? null : a.playState;
  });
  expect(running).toBe("running");
});

test("a waiting reply keeps its letter and gains the hour under it", async ({ page }) => {
  await page.clock.install();
  const { path } = await loadStubbed(page, (base) => [
    session("unread-one", { lastEnded: Date.now(), lastReply: Date.now(), cacheAt: base, ttlMs: HOUR }),
  ]);
  const dot = dotOf(page, path);
  await expect(dot).toHaveClass(/\bunread\b/, { timeout: 20_000 });
  expect(await stateOf(dot)).toEqual(["unread"]);
  await expect(dot.locator("svg")).toHaveCount(1); // the envelope is still the envelope
  // The commonest state in the panel: unread AND the window at its fullest, both in one slot.
  await expect(dot.locator(".cache-track")).toHaveCount(1);
  const width = await dot.locator(".cache-fill").evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(10); // a full hour is very nearly the whole 13px track
  await expect(dot).toHaveAttribute("title", /cached for another \d+ min/);
});

test("a row with nothing waiting is a plain dot, and a spent window leaves no mark at all", async ({ page }) => {
  await page.clock.install();
  const { path } = await loadStubbed(page, (base) => [
    // Amber: under a fifth of the hour left.
    session("warm-one", { cacheAt: base - 50 * MIN, ttlMs: HOUR }),
    // Long spent, and older — the warmest window is the one that speaks (SPEC 257).
    session("cold-one", { cacheAt: base - 5 * HOUR, ttlMs: HOUR }),
  ]);
  const dot = dotOf(page, path);
  // The clock is frozen, so the client's 15s activity poll cannot re-fire on its own. Solo the first
  // paint always beat the assertion; under eight workers it did not, and the row never got a second
  // chance (2026-08-30). Advancing past one poll gives it one.
  await page.clock.runFor(20_000);
  await expect(dot.locator(".cache-fill.low")).toHaveCount(1, { timeout: 20_000 });
  expect(await stateOf(dot)).toEqual([]); // the plain status dot, in the row's own colour

  // Now the other side of the same rule: every window spent, and the row is the row it was before
  // this feature existed — no fill AND no track, because the absence is the message.
  await page.unroute("**/api/activity");
  await page.route("**/api/activity", async (route) => {
    const asked = JSON.parse(route.request().postData() ?? "{}").records ?? [];
    const body = { answered: asked };
    body[path] = [session("cold-only", { cacheAt: Date.now() - 5 * HOUR, ttlMs: HOUR })];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.clock.runFor(20_000);
  await expect(dot.locator(".cache-fill")).toHaveCount(0, { timeout: 30_000 });
  await expect(dot.locator(".cache-track")).toHaveCount(0);
});

test("the hour empties on its own, and asks the network for nothing to do it", async ({ page }) => {
  await page.clock.install();
  test.setTimeout(180_000);
  // A 45-second window rather than an hour, so the whole life of one runs inside a test. The
  // arithmetic is the same fraction of the same two numbers; only the bucket is smaller.
  const SHORT = 45_000;
  const { path } = await loadStubbed(page, (base) => [session("ticking", { cacheAt: base, ttlMs: SHORT })]);
  const dot = dotOf(page, path);
  const fill = dot.locator(".cache-fill");
  await expect(fill).toHaveCount(1, { timeout: 20_000 });
  const before = await fill.evaluate((el) => el.getBoundingClientRect().width);

  // Everything the page asks for from here on. The clock must run off the two numbers the client is
  // already holding — if it needs traffic to stay honest, the feature is wrong (the record's own
  // test of that). The 15 s activity poll already existed; nothing else may appear.
  const asked = [];
  page.on("request", (r) => asked.push(new URL(r.url()).pathname));
  await page.clock.runFor(20_000);
  await expect
    .poll(async () => fill.evaluate((el) => el.getBoundingClientRect().width), { timeout: 60_000 })
    .toBeLessThan(before - 1);
  // `/api/train` is the endpoint a per-row clock would have had to call, once per visible record,
  // every tick. It must never appear — the two numbers ride the poll that already existed.
  expect(asked.filter((p) => p === "/api/train")).toEqual([]);
  expect(asked.filter((p) => p === "/api/activity").length).toBeLessThanOrEqual(6);

  // And at the end of the window the bar is gone entirely, not left as an empty track.
  await page.clock.runFor(30_000);
  await expect(dot.locator(".cache-track")).toHaveCount(0, { timeout: 60_000 });
});

test("a tree redraw never restarts the marching", async ({ page }) => {
  await page.clock.install();
  test.setTimeout(120_000);
  const { path } = await loadStubbed(page, () => [session("still-going", { running: true })]);
  const dot = dotOf(page, path);
  await expect(dot).toHaveClass(/\bworking\b/, { timeout: 20_000 });

  // `loadActivity()` ends in `drawTree()`, which calls `replaceChildren()`, and it runs every 15 s.
  // The phase therefore comes from a shared clock, not from the node's birth: a NEGATIVE delay,
  // re-derived on every build. Restoring a plain `animation-delay: 0` reddens both halves of this.
  const delayOf = () =>
    dot.locator(".march").first().evaluate((el) => Number.parseFloat(getComputedStyle(el).animationDelay));
  const first = await delayOf();
  expect(first).toBeLessThanOrEqual(0);
  expect(first).toBeGreaterThan(-1.1); // inside one lap, so it is a phase and not a pause

  // Sit through at least one poll, which rebuilds every row, and check the phase MOVED with the
  // clock rather than starting over. A node rebuilt from its own birth would read the same 0 twice.
  await page.clock.runFor(20_000);
  await expect.poll(async () => (await delayOf()) !== first, { timeout: 45_000 }).toBe(true);
  const after = await delayOf();
  expect(after).toBeLessThanOrEqual(0);
  await expect(dot.locator(".march")).toHaveCount(3);
  const playing = await dot.locator(".march").first().evaluate((el) => el.getAnimations()[0]?.playState);
  expect(playing).toBe("running");
});

test.describe("with motion turned off", () => {
  test("the dots stand still at full opacity, and the row says the same thing", async ({ page }) => {
    await page.clock.install();
    // `emulateMedia` rather than `test.use({ reducedMotion })`: the project-level fixture builds the
    // context before the describe's options reach it, and the query simply never matched — which
    // looked exactly like a missing CSS rule. The guard below is what tells the two apart next time.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { path } = await loadStubbed(page, () => [session("quiet-march", { running: true })]);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const dot = dotOf(page, path);
    await expect(dot).toHaveClass(/\bworking\b/, { timeout: 20_000 });
    const pip = dot.locator(".march").first();
    // SPEC 261: an animation may say a turn is running somewhere else, but a reader can switch it
    // off — and switched off it is not a dimmer row, it is a still one.
    expect(await pip.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    expect(await pip.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity))).toBe(1);
    await expect(dot.locator(".march")).toHaveCount(3);
  });
});
