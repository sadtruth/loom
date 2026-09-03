/**
 * A huge session costs what a screen costs (SPEC 228).
 *
 * User, 2026-08-20: *"improve the speed of loading sessions in loom. Make them light, even huge
 * ones … I want navigation and opening stuff in loom to feel instant"*, and after the first attempt:
 * *"it's not instant … the shortest path to show the most important content — the last messages in
 * chat — in the shortest amount of time AT THE POSITION WHERE THEY ARE GOING TO BE."* Two complaints,
 * and this spec is written against both: the DOM the session costs, and whether anything MOVES once
 * it is on screen.
 *
 * The fixture is 2,600 turns, which is larger than any session loom had ever been driven against.
 * That size is the point — the claim is that the cost stops growing with the length, and it cannot
 * be checked on a session small enough to draw whole.
 *
 * Two artifacts are planted in it deliberately: a framed prototype thirty turns from the end, which
 * is mounted when the session opens, and a build plan twelve turns from the START, which is
 * thousands of turns above anything that will ever be mounted. The first one proves a turn that
 * survives a round trip through the window is not rebuilt (SPEC 211 — rebuilding a turn re-parents
 * its `<iframe>` and reloads the document inside it). The second proves the gutter is drawn from the
 * data model and not from the rows on screen (SPEC 192).
 */

import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BIG_PROJECT = `${root}/tests/fixture/big`.replace(/[^A-Za-z0-9-]/g, "-");
const BIG = `/?project=${BIG_PROJECT}&session=00000000-fixture-0000-000000000008`;

/** The turn carrying the plan is `PLAN_AT = 12` in `make-fixture.ts`; its answer row is turn 12 × 2 + 2. */
const PLAN_UUID = "88888888-0000-0000-0000-000000000026";
/** ...and the framed prototype at `FRAME_AT = 2600 - 30`. */
const FRAME_UUID = "88888888-0000-0000-0000-000000005142";

/** The whole session, so a count of what is mounted can be read against it. */
const TURNS = 2_600;

async function opened(page) {
  await expect(page.locator("#status")).toContainText("live", { timeout: 30_000 });
  await expect(page.locator(".msg").first()).toBeVisible();
  // The window settles within a frame or two of the first paint, as the estimates it planned from
  // are replaced by the heights the rows actually took.
  await page.waitForTimeout(900);
}

test("windowed: a 2,600-turn session costs a screenful of DOM, not a session of it", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BIG);
  await opened(page);

  const at = await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    return {
      rows: body.querySelectorAll(".msg").length,
      nodes: body.querySelectorAll("*").length,
      status: document.querySelector("#status")?.textContent ?? "",
      scrollHeight: body.scrollHeight,
      client: body.clientHeight,
      last: body.textContent.includes(`turn ${String(2599)}`),
    };
  });

  // The coverage witness: the whole session really is in the client, and this is not a page that
  // simply failed to load. Against the pre-build client this same fixture puts every one of those
  // turns in the DOM.
  expect(at.status, "the client holds the whole session").toContain(`${String(TURNS * 2)} msg`);
  expect(at.rows, "only a screenful of turns is mounted").toBeLessThan(120);
  expect(at.last, "and the LAST turn is one of them — that is what you opened the session for").toBe(true);
  // The scroller is as tall as the whole session: nothing has been truncated, it is simply not built.
  expect(at.scrollHeight, "the whole session is still reachable by scrolling").toBeGreaterThan(at.client * 20);
  expect(errors, "no page errors").toEqual([]);
  console.log(`[window] ${String(at.rows)} rows / ${String(at.nodes)} nodes mounted of ${String(TURNS)} turns · scroller ${String(at.scrollHeight)}px`);
});

test("windowed: nothing on screen moves after the session opens", async ({ page }) => {
  await page.goto(BIG);
  await expect(page.locator("#status")).toContainText("live", { timeout: 30_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  // The first moment there is anything to look at, and then a second and a half later. This is the
  // "at the position where they are going to be" half of the complaint: the last turn must be where
  // it will still be once everything has settled.
  const before = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#transcript-body .msg")];
    const last = rows[rows.length - 1];
    return last === undefined ? null : { uuid: last.dataset.uuid, top: last.getBoundingClientRect().top };
  });
  expect(before, "there is a last turn on screen").not.toBeNull();
  await page.waitForTimeout(1600);
  const after = await page.evaluate((uuid) => {
    const row = document.querySelector(`[data-uuid="${uuid}"]`);
    return row === null ? null : row.getBoundingClientRect().top;
  }, before.uuid);
  expect(after, "the turn that was on screen first is still there").not.toBeNull();
  expect(Math.abs(after - before.top), "and it has not moved").toBeLessThanOrEqual(2);
});

test("windowed: scrolling up mounts history and does not fight the reader", async ({ page }) => {
  await page.goto(BIG);
  await opened(page);

  const start = await page.evaluate(() => document.querySelector("#transcript-body").scrollTop);
  // A real wheel gesture, not a scrollTop assignment: the window redraws on scroll, and a redraw
  // that corrected the position afterwards would make the page sticky under the reader's hand.
  await page.mouse.move(700, 450);
  for (let i = 0; i < 12; i += 1) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  const moved = await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    return { scrollTop: body.scrollTop, rows: body.querySelectorAll(".msg").length };
  });
  // Twelve notches of 400px is 4,800px of intent. Anything that undoes a large part of it is the
  // redraw fighting the gesture — the exact complaint windowing exists to avoid creating.
  expect(start - moved.scrollTop, "the page went where the wheel sent it").toBeGreaterThan(3_000);
  expect(moved.rows, "and the DOM is still a screenful, not everything it passed").toBeLessThan(120);

  // It settles: two reads a frame apart land in the same place.
  const settled = await page.evaluate(async () => {
    const body = document.querySelector("#transcript-body");
    const a = body.scrollTop;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return { a, b: body.scrollTop };
  });
  expect(Math.abs(settled.a - settled.b), "and it stops when the reader stops").toBeLessThanOrEqual(2);
});

test("windowed: a redraw does not reload a prototype the reader is looking at", async ({ page }) => {
  await page.goto(BIG);
  await opened(page);

  // The framed prototype lives thirty turns from the end, which is outside the window a session
  // opens with — so the gutter's own point is what puts it on screen, which is the flow a reader
  // would use anyway.
  await page.locator("#gutter .mm.proto").click();
  await page.waitForTimeout(900);
  const mounted = await page.evaluate(
    (uuid) => document.querySelector(`[data-uuid="${uuid}"] iframe`) !== null,
    FRAME_UUID,
  );
  expect(mounted, "the prototype's turn is on screen after its point is clicked").toBe(true);

  // THE INVARIANT (SPEC 211/203). Re-parenting an `<iframe>` discards its browsing context and
  // reloads the document inside it, so a turn that stays inside the window must come through every
  // redraw untouched. Two marks, because the two ways of breaking it look different: a REBUILT turn
  // makes a brand-new `<iframe>` element, which loses the dataset mark; a MOVED one keeps the
  // element and reloads it, which the load counter sees and the dataset mark would not. The frame is
  // sandboxed, so nothing inside its document can be read from here — these are both read off the
  // element, which is exactly why there have to be two of them.
  const survived = await page.evaluate(async (uuid) => {
    const body = document.querySelector("#transcript-body");
    const frame = document.querySelector(`[data-uuid="${uuid}"] iframe`);
    frame.dataset.pinMark = "1";
    window.__loomFrameLoads = 0;
    frame.addEventListener("load", () => {
      window.__loomFrameLoads += 1;
    });
    // Nudges small enough that the window does not move: the redraw runs, the mounted range is the
    // same, and nothing about this turn has changed.
    for (let i = 0; i < 8; i += 1) {
      body.scrollTop -= 15;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }
    const still = document.querySelector(`[data-uuid="${uuid}"] iframe`);
    return {
      mark: still === null ? "vanished" : (still.dataset.pinMark ?? "rebuilt"),
      loads: window.__loomFrameLoads,
    };
  }, FRAME_UUID);
  expect(survived.mark, "the prototype's own iframe element is the one that was there before").toBe("1");
  expect(survived.loads, "and it was never re-parented, so its document never reloaded").toBe(0);
});

test("windowed: a mounted turn survives a redraw as the same node", async ({ page }) => {
  await page.goto(BIG);
  await opened(page);

  const survived = await page.evaluate(async () => {
    const body = document.querySelector("#transcript-body");
    const rows = [...body.querySelectorAll(".msg")];
    const row = rows[Math.floor(rows.length / 2)];
    if (row === undefined) return "no rows";
    const uuid = row.dataset.uuid;
    row.dataset.pinMark = "1";
    for (let i = 0; i < 8; i += 1) {
      body.scrollTop -= 15;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }
    const still = document.querySelector(`[data-uuid="${uuid}"]`);
    return still === null ? "vanished" : (still.dataset.pinMark ?? "rebuilt");
  });
  expect(survived, "a turn under the reader's eyes is not rebuilt by a redraw").toBe("1");
});

test("windowed: the gutter marks an artifact in a turn it has never drawn", async ({ page }) => {
  await page.goto(BIG);
  await opened(page);

  const state = await page.evaluate((planUuid) => ({
    points: document.querySelectorAll("#gutter .mm").length,
    plans: document.querySelectorAll("#gutter .mm.plan").length,
    protos: document.querySelectorAll("#gutter .mm.proto").length,
    planMounted: document.querySelector(`[data-uuid="${planUuid}"]`) !== null,
  }), PLAN_UUID);

  // The plan is twelve turns from the start of a 2,600-turn session: it is NOT on screen, and under
  // the DOM-walking gutter this build replaced there was no way for it to have a point.
  expect(state.planMounted, "the plan's turn is far outside the window, or this proves nothing").toBe(false);
  expect(state.plans, "the plan has a point anyway — a diamond").toBe(1);
  expect(state.protos, "and the framed prototype has its square").toBe(1);
  expect(state.points, "and nothing else in 2,600 turns is a point").toBe(2);

  // Clicking it takes the reader there, which means mounting a turn that does not exist yet.
  await page.locator("#gutter .mm.plan").click();
  await page.waitForTimeout(900);
  const landed = await page.evaluate((planUuid) => {
    const row = document.querySelector(`[data-uuid="${planUuid}"]`);
    if (row === null) return null;
    const body = document.querySelector("#transcript-body");
    const rect = row.getBoundingClientRect();
    const view = body.getBoundingClientRect();
    return { top: rect.top - view.top, height: view.height };
  }, PLAN_UUID);
  expect(landed, "the turn the point named is now mounted").not.toBeNull();
  expect(landed.top, "and it is on screen, not merely in the document").toBeGreaterThan(-40);
  expect(landed.top).toBeLessThan(landed.height);
});
