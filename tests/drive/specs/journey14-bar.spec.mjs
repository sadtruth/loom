/**
 * Journey 14 — the usage badge (SPEC §The bar — the 5-hour block, while it is still spendable).
 *
 * Rewritten 2026-08-26 (usage-bar build), then again 2026-11-24 when the box moved to Command Code.
 * The badge READS the account's own quota and draws the pool the current session is spending. On
 * this machine that pool is Command Code (`server/quota-commandcode.ts`), which answers three
 * windows: a monthly credit pool, a rolling 5-hour cap and a rolling weekly cap.
 *
 * This stays a journey, not a set of load-time assertions: it drives the stub from 23% through the
 * warning and critical bands, then a failed read, then recovery, and checks the badge follows each
 * state without a reload — a badge that only ever painted once at load would pass a load-time check
 * and still miss the defect these were written for.
 *
 * The stub file (`LOOM_QUOTA_STUB_COMMANDCODE`) is seeded NOW-relative by
 * `tests/playwright.config.mjs` before the server boots, so the FIRST paint already has a reading:
 * 23% on the 5-hour window (3.22 of 14 credits), 8% on the week, 6% on the month. This file only
 * rewrites it from there. The client's own poll (`loadBar`, client/app.ts) fires every 20s — the
 * `LOOM_QUOTA_POLL_MS` override only shortens the SERVER's re-read — so each state change below is
 * followed by a real wait for that cadence, not a reload.
 */

import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

const STUB = process.env["LOOM_QUOTA_STUB_COMMANDCODE"] ?? "";

/**
 * Write the stub in the shape `server/quota-commandcode.ts` expects: the two endpoint bodies, with
 * the 5-hour window as the one the overrides move. `monthlyCredits` is what is LEFT of the plan's
 * 70, so 66 means 4 spent.
 */
function writeStub({ fiveHourUsed = 3.22, fiveHourCap = 14 } = {}) {
  const now = Date.now();
  writeFileSync(
    STUB,
    JSON.stringify({
      credits: {
        credits: { monthlyCredits: 66, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
          limited: true,
          exceeded: null,
          fiveHour: { used: fiveHourUsed, cap: fiveHourCap, exceeded: false, resetAt: now + 4 * 60 * 60 * 1000 },
          weekly: { used: 2.8, cap: 35, exceeded: false, resetAt: now + 40 * 60 * 60 * 1000 },
        },
      },
      subscription: {
        data: { planId: "individual-goat", currentPeriodEnd: new Date(now + 29 * 24 * 60 * 60 * 1000).toISOString() },
      },
    }),
  );
}

const classesOf = async (locator) => (await locator.getAttribute("class")) ?? "";

// Five state changes below each cost a real wait on the client's fixed 20s poll (`loadBar`,
// client/app.ts — not shortened for pins, unlike the server's own re-read of the stub file). The
// suite's 90s default is a timeout on that cadence, not on a defect.
test.setTimeout(220_000);

test("the usage badge reads Command Code's quota, and follows it through warning, critical and a failed read", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");
  const meter = page.locator("#bar-meter");
  const dot = page.locator("#bar-dot");
  const pct = page.locator("#bar-pct");
  const reset = page.locator("#bar-reset");

  // 0. The SERVER's answer first, and with its own body in the message. This spec claims the badge
  //    reads Command Code; if the reading is missing, or the session that happened to open belongs
  //    to the Google family, the symptom is a bare "—" and the cause is invisible. Asserting the
  //    endpoint and then the ACTIVE micro-meter names both facts in the failure.
  const budgets = await (await page.request.get("/api/budgets")).json();
  expect(budgets.budgets.commandcode, `/api/budgets → ${JSON.stringify(budgets.budgets.commandcode)}`).toMatchObject({
    status: "ok",
  });
  await expect(
    page.locator(".micro-bar.active"),
    "the open session spends Command Code's pool, so that is the meter the badge draws",
  ).toHaveAttribute("id", "mb-commandcode");

  // 1. On screen, at the FOOT OF THE RIGHT COLUMN (SPEC 186, unchanged by 249), and the percentage
  //    on first paint is the STUB's number, 23% — the worst of the three windows, read, never
  //    computed from the transcript archive (SPEC 250). The seed write happens before the server
  //    boots (tests/playwright.config.mjs), so this holds on the very first paint, no wait needed.
  await expect(meter).toBeVisible();
  await expect(meter, "the foot of the right column, not the composer row").toHaveJSProperty(
    "parentElement.id",
    "drawer-foot",
  );
  await expect(dot).toBeVisible();
  await expect(pct, "the stub's percentage, exactly — not a number computed from the archive").toHaveText("23%");

  // 2. The reset countdown (SPEC 252: "the time to reset pushed right") counts toward the winning
  //    window's own reset time, ~4h out.
  await expect(reset).toHaveText(/^\d{1,2}h\d{2}m$/);

  // 3. The panel carries what the resting line cannot: all three of Command Code's windows, each
  //    with its own figure. 23, 8 and 6 are three different numbers on purpose — a panel that drew
  //    one window three times cannot pass this.
  // The tooltip is our own element, not the browser's `title` — a native tooltip opens a second
  // after the pointer arrives, and everything the compact line cannot fit was behind that second
  // (2026-08-29). Hovering is what fills it, so the hover is part of the assertion.
  await meter.hover();
  await expect(page.locator("#bar-tip")).toBeVisible();
  const rowValue = async (label) =>
    page.locator("#bar-tip .tip-row", { has: page.locator(`.tip-label:text-is("${label}")`) }).locator(".tip-value").first().textContent();
  // The panel opens on the pool list. There used to be an "active pool" section above it saying the
  // same thing again; the list already marks the active pool with its own arrow.
  await expect(page.locator("#bar-tip .tip-head").first()).toHaveText(/^all pools \(\d+ budgets\)$/);
  expect(await rowValue("Command Code")).toContain("23%");
  expect(await rowValue("↳ 5h window")).toContain("23%");
  expect(await rowValue("↳ weekly")).toContain("8%");
  expect(await rowValue("↳ monthly")).toContain("6%");

  // 4. The colour follows the percentage through the two bands the client draws (75% and 90%). The
  //    Command Code endpoint sends no severity of its own, so the band IS the rule here.
  writeStub({ fiveHourUsed: 11, fiveHourCap: 14 }); // 78.6%
  await new Promise((r) => setTimeout(r, 350));
  await page.clock.runFor(20_000);
  await expect.poll(async () => classesOf(meter)).toMatch(/\bwarm\b/);
  expect(await classesOf(meter)).not.toMatch(/\bhot\b/);
  expect(await classesOf(meter)).not.toMatch(/\bstale\b/);
  await expect(pct, "78.6% rounds to 79%").toHaveText("79%");

  writeStub({ fiveHourUsed: 13.2, fiveHourCap: 14 }); // 94.3%
  await new Promise((r) => setTimeout(r, 350));
  await page.clock.runFor(20_000);
  await expect.poll(async () => classesOf(meter)).toMatch(/\bhot\b/);
  expect(await classesOf(meter)).not.toMatch(/\bwarm\b/);
  await expect(pct).toHaveText("94%");

  // The page stays usable while the badge cycles — this never became a meter with an app attached.
  await expect(page.locator("#composer-text")).toBeEditable();
  await expect(page.locator("#tree-body")).toBeVisible();

  // 5. A failed read never falls back to an estimate (SPEC 251) — it keeps showing the LAST GOOD
  //    reading, and says how old it is only once it is genuinely old. `LOOM_QUOTA_FAIL` cannot be
  //    flipped from inside a spec (it is read from the SERVER's own environment, fixed at boot), so
  //    the stale path is driven the way that IS available from here: a malformed body in the stub
  //    file, which `poll()` treats exactly as a failed fetch — same `stale = true`, same
  //    last-good-kept behaviour.
  writeFileSync(STUB, "{not valid json");
  // The reading is SECONDS old here, and a reading that young is not stale — User, 2026-08-29:
  // *"2 minutes isnt really that stale"*. So the badge must stay exactly as it was: no grey, no
  // note. `AGED_MS` (client/quota-bar.ts) is 8 minutes, which a pin cannot wait out, so what this
  // drives is the SILENCE, which is the behaviour he asked for. The band colour drops for a stale
  // reading, which is what says the failure arrived.
  await new Promise((r) => setTimeout(r, 350));
  await page.clock.runFor(20_000);
  await expect.poll(async () => classesOf(meter)).not.toMatch(/\bhot\b/);
  expect(await classesOf(meter)).not.toMatch(/\bstale\b/);
  expect(await classesOf(meter)).not.toMatch(/\bwarm\b/);
  // The number is still the LAST GOOD one, never replaced by anything the archive could compute.
  await expect(pct, "last good reading — not a fresh archive estimate").toHaveText("94%");
  await meter.hover();
  await expect(page.locator("#bar-tip .tip-note")).toHaveCount(0);

  // 6. A good stub keeps it reading.
  writeStub();
  await new Promise((r) => setTimeout(r, 350));
  await page.clock.runFor(20_000);
  await expect.poll(async () => classesOf(meter)).not.toMatch(/\bstale\b/);
  await expect(pct).toHaveText("23%");

  // 7. The three retired toggles are gone, and so is the old second badge (SPEC 252: "One badge
  //    at the foot, and the three toggles are gone").
  await expect(page.locator("#view-toggles")).toHaveCount(0);
  await expect(page.locator("#view-doc")).toHaveCount(0);
  await expect(page.locator("#t-thinking")).toHaveCount(0);
  await expect(page.locator("#t-meta")).toHaveCount(0);
  await expect(page.locator("#cache-state")).toHaveCount(0);

  // 8. And it survives a 390px viewport, reached through the drawer's own reopen handle — the
  //    same handle SPEC 188 keeps reachable so the column is never hidden outright.
  await page.setViewportSize({ width: 390, height: 844 });
  const handle = page.locator("#drawer-reopen");
  await expect(handle, "the way in is never hidden on a narrow window").toBeVisible();
  await handle.click();
  await expect(meter, "the badge survives 390px").toBeVisible();
  await expect(pct).toHaveText("23%");
  await expect(page.locator("#composer-text")).toBeEditable();
  await expect(page.locator("#tree-body")).toBeVisible();
});
