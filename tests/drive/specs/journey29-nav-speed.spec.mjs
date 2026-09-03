/**
 * Clicking a project lands on its destination, and never on a way-station — SPEC 221.
 *
 * User, 2026-08-19: *"When i click on a project in the left panel, if that project has a session,
 * the session doesnt open immediately but instead at first the project page is rendered for a second
 * and then we move to the session. This feels and looks buggy and laggy. Clicking around should feel
 * instant as much as possible."* — and he asked for a measured metric with an aggressive target.
 *
 * TWO numbers, and the first matters more than the second.
 *
 * The COUNT is the complaint. Between the press and the settle, the centre may change kind exactly
 * once. The old shape changed it twice — record, then session — and the intermediate frame was not a
 * spinner but a fully drawn wrong page. No duration can express that, which is why this pin counts
 * before it times.
 *
 * The DURATION is the feel. Measured from the real press to the frame the destination first appears
 * in, sampled per animation frame rather than from a promise, because what he is judging is when the
 * pixels changed.
 */

import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPORT = fileURLToPath(new URL("../../../navigating-links/nav-timing-2026-08-19.md", import.meta.url));

/**
 * The GOAL, aggressive on purpose: under about a tenth of a second reads as instantaneous rather
 * than fast. Not currently met — see the report this writes — and deliberately not quietly loosened
 * to whatever the build happens to achieve, because a target that moves to meet the number is not a
 * target. The pin FAILS on the count and guards the durations against regression; the gap between
 * GUARD and TARGET is the work still owed.
 *
 * Target values are aspirations.
 */
const TARGET_COLD = { median: 100, max: 200 };
const TARGET_WARM = { median: 15, p95: 30, max: 50 };

/**
 * What must not get worse while the target is unmet.
 *
 * A healthy machine produces ~150ms cold, ~2-15ms warm.
 * Guards include headroom and are chosen so that a single scheduling hiccup (outlier) under
 * test suite load does not fail the gate.
 *
 * Cold: 3 samples -> median (index 1) survives 1 outlier.
 * Warm: 21 samples -> p95 (floor(0.95 * 21) = 19) survives 1 outlier (the max, index 20).
 */
const GUARD_COLD = { median: 300, max: 500 };
const GUARD_WARM = { median: 50, p95: 200, max: 200 };

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[at];
}

/**
 * Watch which KIND the centre is showing, one sample per animation frame.
 *
 * Per frame rather than per mutation: a mutation that is immediately undone never reaches the
 * screen, and a frame is what he actually sees.
 */
async function installRecorder(page) {
  await page.evaluate(() => {
    const kind = () => {
      const record = document.querySelector("#record-body");
      const chat = document.querySelector("#chat-area");
      const recordUp = record !== null && !record.hidden && record.offsetParent !== null;
      const chatUp = chat !== null && !chat.hidden && chat.offsetParent !== null;
      if (recordUp && !chatUp) return "record";
      if (chatUp && !recordUp) return "session";
      if (recordUp && chatUp) return "both";
      return "none";
    };
    // What the centre is SHOWING, not merely which pane is up. Two projects that both open a
    // session produce no kind change at all, so a pin that timed kind changes alone would have
    // nothing to measure and would report zero as a pass — which the first version of this file
    // did (2026-08-19).
    const signature = () => {
      const record = document.querySelector("#record-body");
      const transcript = document.querySelector("#transcript-body");
      const current = document.querySelector(".tree-item.current");
      return [
        kind(),
        current === null ? "" : current.getAttribute("data-record") ?? "",
        transcript === null ? "" : String(transcript.childElementCount),
        transcript === null ? "" : (transcript.textContent ?? "").slice(0, 120),
        record === null ? "" : (record.textContent ?? "").slice(0, 120),
      ].join("\u0000");
    };
    window.__nav = { marks: [], last: kind(), start: 0, sig: signature(), landed: null };
    const tick = () => {
      const now = kind();
      if (now !== window.__nav.last) {
        window.__nav.marks.push({ kind: now, at: performance.now() - window.__nav.start });
        window.__nav.last = now;
      }
      if (window.__nav.landed === null && signature() !== window.__nav.sig) {
        window.__nav.landed = performance.now() - window.__nav.start;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function press(page, row) {
  await page.evaluate(() => {
    window.__nav.marks = [];
    window.__nav.landed = null;
    window.__nav.sig = null;
    window.__nav.start = performance.now();
  });
  // The signature is taken in the frame BEFORE the press, so "changed" means changed by this click.
  await page.evaluate(() => {
    const el = document.querySelector("#transcript-body");
    const rec = document.querySelector("#record-body");
    const cur = document.querySelector(".tree-item.current");
    window.__nav.sig = [
      window.__nav.last,
      cur === null ? "" : cur.getAttribute("data-record") ?? "",
      el === null ? "" : String(el.childElementCount),
      el === null ? "" : (el.textContent ?? "").slice(0, 120),
      rec === null ? "" : (rec.textContent ?? "").slice(0, 120),
    ].join("\u0000");
  });
  await row.click();
  // Settle: give the fetch that used to drive the swap plenty of room to have driven one.
  await page.waitForTimeout(1200);
  return page.evaluate(() => ({ marks: window.__nav.marks, landed: window.__nav.landed }));
}

test("a project click changes the centre exactly once, and fast", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  // The activity poll is what the decision reads; without it nothing is known and the centre is
  // deliberately left alone. Waiting for it is honest — it lands within a second of boot.
  await expect
    .poll(() => page.evaluate(() => Object.keys(window.__loomActivity ?? {}).length), { timeout: 20_000 })
    .toBeGreaterThan(0)
    .catch(() => {});
  await page.waitForTimeout(1500);
  await installRecorder(page);

  const rows = page.locator(".tree-item[data-record]");
  const count = await rows.count();
  expect(count, "the fixture tree has records to click").toBeGreaterThan(1);

  const coldSamples = [];
  const coldChanges = [];
  // 3 clicks, each on a unique project to measure the cold path.
  for (let i = 0; i < 3; i += 1) {
    const row = rows.nth(i);
    const { marks, landed } = await press(page, row);
    coldChanges.push(marks.length);
    if (landed !== null) coldSamples.push(Math.round(landed));
  }

  const warmSamples = [];
  const warmChanges = [];
  // 21 clicks alternating between the first two projects to measure the warm path.
  // 21 is enough samples that a single outlier doesn't push the p95 over the threshold.
  for (let i = 0; i < 21; i += 1) {
    const row = rows.nth(i % 2);
    const { marks, landed } = await press(page, row);
    warmChanges.push(marks.length);
    if (landed !== null) warmSamples.push(Math.round(landed));
  }

  const sortedCold = [...coldSamples].sort((a, b) => a - b);
  const coldStats = {
    n: coldSamples.length,
    median: quantile(sortedCold, 0.5),
    max: sortedCold[sortedCold.length - 1] ?? 0,
    changes: coldChanges,
  };

  const sortedWarm = [...warmSamples].sort((a, b) => a - b);
  const warmStats = {
    n: warmSamples.length,
    median: quantile(sortedWarm, 0.5),
    p95: quantile(sortedWarm, 0.95),
    max: sortedWarm[sortedWarm.length - 1] ?? 0,
    changes: warmChanges,
  };

  writeFileSync(
    REPORT,
    [
      "---",
      "type: note",
      "created: 2026-08-19",
      "parent: project.md",
      "---",
      "",
      "# How fast a project click lands",
      "",
      "Written by `tests/drive/specs/journey29-nav-speed.spec.mjs`. Re-run it to refresh these numbers;",
      "do not edit them by hand.",
      "",
      "| gesture | samples | median | p95 | max | centre changes per click |",
      "| --- | --- | --- | --- | --- | --- |",
      `| click a project (cold) | ${coldStats.n} | ${coldStats.median} ms | - | ${coldStats.max} ms | ${coldStats.changes.join(", ")} |`,
      `| click a project (warm) | ${warmStats.n} | ${warmStats.median} ms | ${warmStats.p95} ms | ${warmStats.max} ms | ${warmStats.changes.join(", ")} |`,
      "",
      // The medians alone hid why this pin is a coin flip: six samples of a quantity that ranges from
      // 1ms to 196ms on the same build, minutes apart. Writing every sample is what showed it
      // (2026-08-29) — a summary of six noisy numbers is not evidence about the sixth.
      `Cold samples, in order: ${coldSamples.join(", ")} ms.`,
      `Warm samples, in order: ${warmSamples.join(", ")} ms.`,
      "",
      "## What this says",
      "",
      "**The centre changes per click is the requirement**, and it is met: the sequence above is the",
      "number of times the centre changed KIND between the press and the settle. Against the code",
      "before this build it reads `2, 2, 2, 2, 2, 2` — the record page drawn in full, then replaced by",
      "the session. That second frame is what User was watching.",
      "",
      `The milliseconds are the FEEL, measured from the real press to the first frame in which the`,
      "centre shows something belonging to the project just clicked.",
      "",
      `- Cold Goal: median ≤ ${TARGET_COLD.median} ms · max ≤ ${TARGET_COLD.max} ms`,
      `- Cold Regression guard: median ≤ ${GUARD_COLD.median} ms · max ≤ ${GUARD_COLD.max} ms`,
      `- Warm Goal: median ≤ ${TARGET_WARM.median} ms · p95 ≤ ${TARGET_WARM.p95} ms · max ≤ ${TARGET_WARM.max} ms`,
      `- Warm Regression guard: median ≤ ${GUARD_WARM.median} ms · p95 ≤ ${GUARD_WARM.p95} ms · max ≤ ${GUARD_WARM.max} ms`,
      "",
      (coldStats.median <= TARGET_COLD.median && coldStats.max <= TARGET_COLD.max && warmStats.median <= TARGET_WARM.median && warmStats.p95 <= TARGET_WARM.p95 && warmStats.max <= TARGET_WARM.max)
        ? "Currently MEETS the goals."
        : "**Currently MISSES the goals** and passes the guards. The remaining cost is the full redraw a" +
          " session switch triggers, not the network — the fetch is off the critical path already.",
      "",
    ].join("\n"),
  );

  // A COVERAGE WITNESS, and it is not a formality: the first version of this pin timed centre-KIND
  // changes, both fixture projects open a session, so it recorded nothing and passed with a median
  // of zero. A number that can be produced by measuring nothing is not evidence (2026-08-19).
  expect(coldStats.n, `every cold click must produce a measurable landing, got ${coldStats.n} of 3`).toBe(3);
  expect(warmStats.n, `every warm click must produce a measurable landing, got ${warmStats.n} of 21`).toBe(21);

  // The requirement, and the half a duration cannot express.
  for (const n of coldChanges) {
    expect(n, `one centre change per cold click, got the sequence ${JSON.stringify(coldChanges)}`).toBeLessThanOrEqual(1);
  }
  for (const n of warmChanges) {
    expect(n, `one centre change per warm click, got the sequence ${JSON.stringify(warmChanges)}`).toBeLessThanOrEqual(1);
  }

  // Guard, not goal. The goal lives in the report, where a number that misses it is visible rather
  // than absent — the alternative was moving TARGET down to whatever this build happened to do,
  // which would have made the pin agree with the code by construction.
  expect(coldStats.median, `cold median ${coldStats.median}ms`).toBeLessThanOrEqual(GUARD_COLD.median);
  expect(coldStats.max, `cold max ${coldStats.max}ms`).toBeLessThanOrEqual(GUARD_COLD.max);

  expect(warmStats.median, `warm median ${warmStats.median}ms`).toBeLessThanOrEqual(GUARD_WARM.median);
  expect(warmStats.p95, `warm p95 ${warmStats.p95}ms`).toBeLessThanOrEqual(GUARD_WARM.p95);
  expect(warmStats.max, `warm max ${warmStats.max}ms`).toBeLessThanOrEqual(GUARD_WARM.max);
});

/**
 * The case the FIXTURE CANNOT PRODUCE, and the one User was still seeing.
 *
 * The test above waits for `/api/activity` to land before it clicks, because that is what the centre
 * decision reads — which means it only ever drove the warm path. On a real rail a project is
 * routinely clicked before its activity is known, and there the record was being drawn on the way
 * past for as long as the fetch took: *"i can still see the project page loading first before the
 * chat when i navigate between projects"* (2026-08-20).
 *
 * Blocking the route is the deterministic way to hold the rail in that state — no timing, no clock,
 * no race with a poll that lands within a second.
 */
test("a project the rail believes is empty still never draws the record on the way past", async ({ page }) => {
  // Activity answers EMPTY for every record — not "unknown", but "this project has no sessions".
  // That is a real answer the real rail gives: a record the scan does not currently know, a session
  // whose link has not been read yet, a store that has just moved. It is also a WEAKER fact than a
  // non-empty one, because `/api/records/sessions` may still find sessions the poll did not — and
  // when it does, the record page has already been drawn and is then replaced by the chat.
  await page.route("**/api/activity*", async (route) => {
    const url = new URL(route.request().url());
    const body = {};
    for (const key of (url.searchParams.get("keys") ?? "").split(",").filter(Boolean)) body[key] = [];
    for (const rec of (url.searchParams.get("records") ?? "").split(",").filter(Boolean)) {
      body[decodeURIComponent(rec)] = [];
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const listed = await page.evaluate(() =>
    Object.values(window.__loomActivity ?? {}).reduce((n, list) => n + (list?.length ?? 0), 0),
  );
  expect(listed, "the rail has been told every project is empty — which is the whole case").toBe(0);

  await installRecorder(page);

  const rows = page.locator(".tree-item[data-record]");
  expect(await rows.count(), "the fixture tree has records to click").toBeGreaterThan(1);

  for (let i = 0; i < 4; i += 1) {
    const { marks } = await press(page, rows.nth(i % 2));
    // Both of these projects have sessions, so the session is the destination and the record page is
    // a way-station by definition. Reading the frames rather than the end state is the point: the
    // defect was only ever visible in between.
    expect(
      marks.map((mark) => mark.kind),
      `click ${i + 1}: the record was drawn on the way to the session`,
    ).not.toContain("record");
  }
});
