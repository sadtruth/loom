/**
 * The train, driven end to end (SPEC §Train).
 *
 * User, 2026-08-07: *"Each project or subproject should get 1 continuous session which is knitted
 * from multiple session. A train of sessions … an indicator whether this one is still fresh in cache
 * or if its stale."*
 *
 * A narrow assertion would prove nothing here. The whole claim is that many sessions READ as one
 * line of work, so the spec enters a project, finds the seam above the session it landed in, opens
 * the earlier car THROUGH it, and asserts both cars are on screen at once with the seam still
 * between them. Then it drives the cost mark two-sided — the newest car is warm, the older one is
 * cold — because a mark stuck on a constant passes any one-sided check.
 */

import { expect, test } from "@playwright/test";

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource.*\b(400|403|404|409|413|415)\b/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function enterTheTrain(page) {
  await page.locator(".tree-item", { hasText: "Fixture train project" }).first().click();
  await page.locator('.open-row[data-kind="session"]').click();
}

test("a train reads as one line of work, with the seam visible between its cars", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await enterTheTrain(page);

  // Landed in the NEWEST car — that is where typing goes.
  await expect(page.locator("#transcript-body")).toContainText("the newest car of this train", {
    timeout: 20_000,
  });
  // …and the older one is NOT dragged in unasked: a train is read lazily, one car at a time.
  // Asserted over MESSAGES, not the pane: the seam naming the earlier car is supposed to be there.
  const firstCarTurns = page.locator(".msg", { hasText: "the first car of this train" });
  await expect(firstCarTurns).toHaveCount(0);

  // Two seams, visible: one offering the earlier car, one marking where this session begins.
  const seams = page.locator(".seam");
  await expect(seams).toHaveCount(2);
  const opener = page.locator("button.seam-open");
  await expect(opener).toHaveCount(1);
  await expect(opener).toContainText("earlier session");
  await expect(page.locator(".seam.current")).toContainText("this session");

  // ── open the earlier car through its own seam ───────────────────
  await opener.click();
  await expect(firstCarTurns.first()).toBeVisible({ timeout: 20_000 });
  // BOTH cars' turns on screen at once, still separated — the whole feature in three assertions.
  await expect(page.locator(".msg", { hasText: "the newest car of this train" }).first()).toBeVisible();
  await expect(page.locator(".seam")).toHaveCount(2);
  await expect(page.locator(".seam.current")).toHaveCount(1);
  // The seam that was a door is now a label: there is nothing left to open.
  await expect(page.locator("button.seam-open")).toHaveCount(0);

  // Order is reading order, not recency: the earlier car's turns come BEFORE the newer car's.
  const order = await page.locator("#transcript-body .msg").allInnerTexts();
  const firstAt = order.findIndex((t) => t.includes("the first car of this train"));
  const newestAt = order.findIndex((t) => t.includes("the newest car of this train"));
  expect(firstAt, "the earlier car is on screen").toBeGreaterThanOrEqual(0);
  expect(firstAt, "the earlier car is rendered above the newer one").toBeLessThan(newestAt);

  expect(errors, "no page errors across the train flow").toEqual([]);
});

/**
 * Cutting a seam, driven. User, 2026-08-07: *"so i clicked the 'start a new one' button and it
 * moved me to another session and it didnt look like the same window being a train for many
 * sessions."* It did not, because a composed-but-unsent session has no id and the train computed to
 * nothing — the whole history vanished at the one moment continuity has to be visible.
 *
 * So this asserts what the click must LEAVE ON SCREEN, not what it navigates to.
 */
test("cutting a seam keeps the train on screen, with the car you were reading still open", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await enterTheTrain(page);
  await expect(page.locator(".msg", { hasText: "the newest car of this train" }).first()).toBeVisible({
    timeout: 20_000,
  });
  const before = await page.locator(".seam").count();
  expect(before).toBe(2);

  await page.locator("#composer-new").click();

  // The history is STILL THERE — this is the whole bug.
  await expect(page.locator(".seam")).toHaveCount(3);
  // …and the car he was reading a second ago stayed open rather than collapsing behind a door.
  await expect(page.locator(".msg", { hasText: "the newest car of this train" }).first()).toBeVisible();
  // The new seam names itself honestly: nothing has been sent, so there is nothing to date.
  await expect(page.locator(".seam.current")).toHaveCount(1);
  await expect(page.locator(".seam.current")).toContainText("nothing sent yet");
  // The earlier car is still one click away, not force-loaded.
  await expect(page.locator("button.seam-open")).toHaveCount(1);
  // And the cut he just made is ON SCREEN. `scrollToEnd` aligns the last MESSAGE, and the new seam
  // is below every message, so it landed under the fold — the one thing he needed to see.
  await expect(page.locator(".seam.current")).toBeInViewport();
  // No cost to report on a session that has made no call, and nothing to cut from. `#cache-state`
  // is gone (SPEC 252) — the cache countdown is the "cache …" segment of `#bar-meter` now, at
  // `#bar-cache`, and it is `hidden` on exactly the same condition: no cache to report.
  await expect(page.locator("#bar-cache")).toBeHidden();
  await expect(page.locator("#composer-new")).toBeHidden();

  expect(errors, "no page errors across the seam-cutting flow").toEqual([]);
});

test("the mark says what typing here costs, and says something different in a stale car", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await enterTheTrain(page);

  // `#cache-state` is gone (SPEC 252): the cache countdown drew separately before, and now it is
  // the "cache …" segment of the one foot badge, `#bar-cache` inside `#bar-meter`. The resting line
  // only has room for a compact duration now — the words this test used to read off the badge
  // itself ("cached for another", "cache expired", "re-reads Xk") moved into the tooltip
  // (`buildBarTooltip`) — loom's own `#bar-tip` element since 2026-08-29, opened by hovering the
  // badge, because the browser's `title` waits a second before it appears.

  // ── the newest car: called ten minutes ago, inside its 1-hour bucket ──
  const mark = page.locator("#bar-cache");
  const meter = page.locator("#bar-meter");
  await expect(mark).toBeVisible({ timeout: 20_000 });
  // Not flagged urgent — well inside its hour, so no `cwarn`/`cold` class and a plain countdown.
  await expect(mark, "not flagged urgent — well inside its hour").not.toHaveClass(/cwarn|cold/);
  await expect(mark).toContainText(/^cache (\d+h)?\d+m$/);
  // 118k read + 2k written + 3 fresh — and NOT the 500-token subagent row that sits newer in the
  // same file. A reader counting sidechain usage would say "0k" here.
  await meter.hover();
  await expect(page.locator("#bar-tip"), "the context size a cold turn would rewrite, in the tooltip").toContainText(
    /120k/,
  );

  // The button that opens a seam is there, and it is the only way one opens.
  await expect(page.locator("#composer-new")).toBeVisible();

  // ── the older car: its bucket expired hours ──────────────────
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  await page.locator("#select-claude").selectOption({ index: 1 });
  await expect(page.locator("#transcript-body")).toContainText("the first car of this train", {
    timeout: 20_000,
  });
  await expect(mark).toHaveClass("cache cold");
  await expect(mark).toContainText("cache cold");
  await meter.hover();
  await expect(page.locator("#bar-tip")).toContainText(/70k/);

  // ── outside a project there is no train, so there is no mark ─────
  await page.locator(".tree-item.general").click();
  await expect(page.locator("#bar-cache")).toBeHidden();
  await expect(page.locator("#composer-new")).toBeHidden();
  await expect(page.locator(".seam")).toHaveCount(0);

  expect(errors, "no page errors across the cost-mark flow").toEqual([]);
});


/**
 * A draft belongs to the session it was typed for (scenario 6, the plan's own failure case).
 *
 * `ui.composerText.value` used to be cleared only on send, so a draft silently followed him into
 * whichever session he picked next and would have been sent there. Invisible while the composer was
 * a fixed bar; with the `unsent` mark of SPEC 199 it becomes a lie about which session is waiting on
 * him. Driven here because the train project is the one fixture with two real sessions in it.
 */
test("a draft stays with the session it was typed for", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await enterTheTrain(page);

  const picker = page.locator("#select-claude");
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  const box = page.locator("#composer-text");
  const ids = await picker.locator("option").evaluateAll((nodes) =>
    nodes.map((n) => n.value).filter((v) => !v.startsWith("__")),
  );
  expect(ids.length, "the train has two cars, so there are two sessions to switch between").toBeGreaterThan(1);
  const here = await picker.inputValue();
  const there = ids.find((id) => id !== here);

  await box.fill("a draft for the car I am reading");
  await expect(box).toHaveValue("a draft for the car I am reading");

  // ── to the other session: the box is ITS box, and it is empty ──
  await picker.selectOption(there);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(box, "a session that had no draft opens empty").toHaveValue("");

  // ── back: the draft is where it was left ──
  await picker.selectOption(here);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(box, "the draft waited in the session it was typed for").toHaveValue(
    "a draft for the car I am reading",
  );

  // And the other session still has nothing of his in it.
  await picker.selectOption(there);
  await expect(box).toHaveValue("");

  // ── a send clears the SENDING session's draft and nobody else's ──
  await box.fill("this one goes now");
  await box.press("Enter");
  await expect(box, "the box he sent from is empty").toHaveValue("");
  await expect(page.locator("#transcript-body")).toContainText("stub reply:", { timeout: 30_000 });
  await picker.selectOption(here);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(box, "sending in one session does not throw away another's draft").toHaveValue(
    "a draft for the car I am reading",
  );

  // ── a session that has NO id yet holds a draft too ──────────────
  // Clicking `+` (#add-claude) is composed against no session id at all, so its draft is keyed on the context
  // rather than on an id. It still has to survive a walk away and back.
  await page.locator("#add-claude").click();
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  await expect(box, "a session that does not exist yet starts empty").toHaveValue("");
  await box.fill("a draft for a session that does not exist yet");
  await picker.selectOption(here);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(box, "the named session's own draft, not the unnamed one's").toHaveValue(
    "a draft for the car I am reading",
  );
  await page.locator("#add-claude").click();
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  await expect(box, "the unnamed session's draft waited for it").toHaveValue(
    "a draft for a session that does not exist yet",
  );
  await box.fill("");

  expect(errors, "no page errors across the draft flow").toEqual([]);
});
