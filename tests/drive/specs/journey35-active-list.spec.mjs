/**
 * P35 — the Active list: what is live, flat, newest first (SPEC 247–249).
 *
 * User on the prototype, 2026-08-26: *"1. call it 'Active' 2. show only in selected core. So if
 * it's personal then personal if all then all if work then work and so on 3. within it, sort by
 * recency"*. All three are driven here.
 *
 * `/api/activity` is STUBBED rather than fabricated on disk: the list is a second read of exactly
 * that response, so faking it is faking the input and not the answer — and the fixture's own
 * sessions carry no `lastTyped` at all, which is the state the empty case below drives.
 *
 * Fails against the pre-build client on the very first assertion: `#active-head` does not exist.
 */

import { expect, test } from "@playwright/test";

const MIN = 60_000;
const H = 60 * MIN;

const live = async (page) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
};

/**
 * Stub `/api/activity` for two of the records the CLIENT ACTUALLY HOLDS, and say which.
 *
 * The two are chosen inside the handler, from the request's own `records` list intersected with the
 * rows the tree was drawing a moment ago — not from a snapshot taken before the reload. Earlier
 * specs in the suite create and delete records (journey16, journey34), so a path read once and
 * assumed still there produced one row where the test wanted two: green alone, red in the suite,
 * which is the worst shape a pin can have. The request is the only reading of "what exists" that
 * cannot be stale.
 *
 * Ages are computed at REQUEST time so they stay right however long the page has been open, and the
 * OLDER one is written into the body first — a list that came out in insertion order would read
 * backwards and pass nothing here.
 */
const stubTwoActive = async (page, visible) => {
  const picked = {};
  await page.route("**/api/activity", async (route) => {
    const asked = JSON.parse(route.request().postData() ?? "{}").records ?? [];
    const both = [...asked].filter((p) => visible.has(p)).sort();
    picked.newer = both[0];
    picked.older = both[1];
    const now = Date.now();
    const session = (id, ago) => [{ id, mtime: now - ago, lastReply: now - ago, lastEnded: 0, lastTyped: now - ago }];
    const body = { answered: both };
    if (picked.older !== undefined) body[picked.older] = session("older-session", 3 * H + MIN);
    if (picked.newer !== undefined) body[picked.newer] = session("newer-session", 4 * MIN + 20_000);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  return picked;
};

/** The record paths the tree is drawing right now. */
const visibleRecords = async (page) => {
  const rows = page.locator(".tree-item[data-record]");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  return new Set(await rows.evaluateAll((els) => els.map((e) => e.dataset.record)));
};

/** Load, stub against what is on screen, reload into the stub, and hand back the two paths. */
const loadWithTwoActive = async (page) => {
  await live(page);
  const picked = await stubTwoActive(page, await visibleRecords(page));
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".active-item")).toHaveCount(2, { timeout: 20_000 });
  return picked;
};

test("the list is headed Active, newest first, and each row says how long ago", async ({ page }) => {
  const { newer, older } = await loadWithTwoActive(page);
  const titleOf = async (path) =>
    (await page.locator(`.tree-item[data-record="${path}"] .tree-label`).textContent()).trim();
  const [newerTitle, olderTitle] = [await titleOf(newer), await titleOf(older)];

  const head = page.locator("#active-head");
  await expect(head).toBeVisible({ timeout: 20_000 });
  await expect(head).toContainText("Active");

  const rows = page.locator(".active-item");
  // ORDER is the requirement, and the stub deliberately supplied the older one first.
  expect(await rows.nth(0).getAttribute("data-record")).toBe(newer);
  expect(await rows.nth(1).getAttribute("data-record")).toBe(older);
  await expect(rows.nth(0).locator(".active-label")).toHaveText(newerTitle);
  await expect(rows.nth(1).locator(".active-label")).toHaveText(olderTitle);
  await expect(rows.nth(0).locator(".active-age")).toHaveText("4 min");
  await expect(rows.nth(1).locator(".active-age")).toHaveText("3 h");
  // No core chip: the list only ever shows one core's worth (248).
  await expect(rows.nth(0).locator(".core-chip")).toHaveCount(0);
});

test("a row enters the project, the same gesture the tree row is", async ({ page }) => {
  const { older } = await loadWithTwoActive(page);

  const second = page.locator(".active-item").nth(1);
  await expect(second).toHaveAttribute("data-record", older);
  await second.click();

  // The tree agrees about where he is standing — one place, entered from the other list.
  await expect(page.locator(`.tree-item[data-record="${older}"]`)).toHaveClass(/current/, {
    timeout: 20_000,
  });
  await expect(page.locator(`.active-item[data-record="${older}"]`)).toHaveClass(/current/);
});

/**
 * User, 2026-08-29: the Active rows were "all blue balls", while the tree next to them was
 * saying status, age and a waiting reply. The requirement is not "a mark exists" — it is that the
 * SAME project wears the SAME mark in both lists, so the check compares the two rows against each
 * other rather than against a literal.
 */
test("a row's mark is the mark its tree row wears", async ({ page }) => {
  const { newer, older } = await loadWithTwoActive(page);

  for (const path of [newer, older]) {
    const treeRow = page.locator(`.tree-item[data-record="${path}"]`);
    const activeRow = page.locator(`.active-item[data-record="${path}"]`);
    // The status colour rides on the ROW's class in both lists — one set of `.status-* .tree-dot`
    // rules, no second copy to drift.
    const statusOf = async (row) =>
      (await row.getAttribute("class")).split(/\s+/).filter((c) => c.startsWith("status-"));
    expect(await statusOf(activeRow)).toEqual(await statusOf(treeRow));

    const mark = async (row) => {
      const dot = row.locator(".tree-dot");
      await expect(dot).toHaveCount(1);
      return dot.evaluate((el) => ({
        classes: [...el.classList].sort().join(" "),
        text: el.textContent,
        svgs: el.querySelectorAll("svg").length,
        color: getComputedStyle(el).color,
      }));
    };
    expect(await mark(activeRow)).toEqual(await mark(treeRow));
  }

  // Two-sided: the ring is what put these rows in the list, so it must really be on the mark. A
  // pin that only compared the two lists would still pass if BOTH lost the ring.
  await expect(page.locator(`.active-item[data-record="${newer}"] .tree-dot`)).toHaveClass(/\bactive\b/);
});

test("the core selector scopes the list, exactly as it scopes the tree", async ({ page }) => {
  await loadWithTwoActive(page);

  const select = page.locator("#core-select");
  const values = await select
    .locator("option:not([disabled])")
    .evaluateAll((os) => os.map((o) => o.value).filter((v) => v.length > 0));
  test.skip(values.length === 0, "no usable core in this fixture");

  // A core that owns none of the fixture's records: the SAME stub still says two projects are
  // active, and the list must go quiet anyway. This is the assertion the cross-core design would
  // have failed — it listed every core regardless of the selector.
  let scoped = false;
  for (const value of values) {
    await select.selectOption(value);
    await expect(page).toHaveURL(new RegExp(`core=${value}`));
    if ((await page.locator(".tree-item[data-record]").count()) > 0) continue;
    await expect(page.locator(".active-item")).toHaveCount(0);
    // Nothing active means nothing drawn — no heading either (249).
    await expect(page.locator("#active-head")).toBeHidden();
    scoped = true;
    break;
  }
  test.skip(!scoped, "every usable core owns fixture records; no empty core to scope against");

  // Back to every core, and the two rows return.
  await select.selectOption("");
  await expect(page.locator(".active-item")).toHaveCount(2, { timeout: 20_000 });
});

test("nothing typed anywhere draws nothing at all", async ({ page }) => {
  await page.route("**/api/activity", async (route) => {
    // The honest empty answer: the records were asked about and have no sessions.
    const body = await (await route.fetch()).json();
    const empty = Object.fromEntries(Object.keys(body).filter((k) => k !== "answered").map((k) => [k, []]));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...empty, answered: body.answered ?? [] }) });
  });
  await live(page);
  await expect(page.locator(".tree-item[data-record]").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".active-item")).toHaveCount(0);
  await expect(page.locator("#active-head")).toBeHidden();
  await expect(page.locator("#active-body")).toBeHidden();
});
