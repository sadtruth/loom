/**
 * Journey 14 — the usage badge (SPEC §The bar — the 5-hour block, while it is still spendable).
 *
 * Rewritten 2026-08-26 (usage-bar build). The old pin drove the fitted-estimate meter — calls
 * burned into the archive, a "cool"/"warm"/"hot" ramp keyed to a threshold loom invented. That
 * whole mechanism is retired (SPEC 122, 123): the badge now READS the account's own quota
 * (`server/usage.ts`, `LOOM_QUOTA_STUB`) and its severity is the account's OWN opinion, not a
 * percentage loom compares to a number. So this stays a journey, not a set of load-time
 * assertions: it drives the stub through normal → warning → critical → a failed read →
 * recovered, and checks the badge follows each state without a reload — a badge that only ever
 * painted once at load would pass a load-time check and still miss the defect 247/248 exist to
 * close.
 *
 * The stub file (`LOOM_QUOTA_STUB`) is seeded NOW-relative by `tests/playwright.config.mjs`
 * before the server boots, so the FIRST paint already has a reading — 23% on the session window,
 * 41% on the weekly one. This file only rewrites it from there. The client's own poll
 * (`loadBar`, client/app.ts) fires every 20s regardless of test wiring — `LOOM_QUOTA_POLL_MS`
 * only shortens the SERVER's re-read of the stub file — so each state change below is followed by
 * a real wait for that cadence, not a reload.
 */

import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

const STUB = process.env["LOOM_QUOTA_STUB"] ?? "";

/**
 * Write the stub the shape `readQuota` (server/usage.ts) expects: a `limits` array, `kind:
 * "session"` for the five-hour window the badge itself draws, `kind: "weekly_all"` for the figure
 * that only shows up in the tooltip. `overrides` patches the session entry only — every step below
 * moves the session window's severity, never the percentage, so a change in the meter's colour can
 * never be explained by the percentage itself moving (SPEC 250).
 */
function writeStub(overrides = {}) {
  const now = Date.now();
  writeFileSync(
    STUB,
    JSON.stringify({
      limits: [
        {
          kind: "session",
          percent: 23,
          severity: "normal",
          resets_at: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
          ...overrides,
        },
        {
          kind: "weekly_all",
          percent: 41,
          severity: "normal",
          resets_at: new Date(now + 40 * 60 * 60 * 1000).toISOString(),
        },
      ],
    }),
  );
}

const classesOf = async (locator) => (await locator.getAttribute("class")) ?? "";

// Five state changes below each cost a real wait on the client's fixed 20s poll (`loadBar`,
// client/app.ts — not shortened for pins, unlike the server's own re-read of the stub file). The
// suite's 90s default is a timeout on that cadence, not on a defect.
test.setTimeout(220_000);

test("the usage badge reads the account's quota, and follows it through warning, critical and a failed read", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");
  const meter = page.locator("#bar-meter");
  const dot = page.locator("#bar-dot");
  const pct = page.locator("#bar-pct");
  const reset = page.locator("#bar-reset");

  // 1. On screen, at the FOOT OF THE RIGHT COLUMN (SPEC 186, unchanged by 249), and the percentage
  //    on first paint is the STUB's number, 23% — not anything derived from the transcript
  //    archive. That single figure is the whole point of the build (SPEC 250): the percentage is
  //    READ, never estimated. The seed write happens before the server boots
  //    (tests/playwright.config.mjs), so this holds on the very first paint, no wait needed.
  await expect(meter).toBeVisible();
  await expect(meter, "the foot of the right column, not the composer row").toHaveJSProperty(
    "parentElement.id",
    "drawer-foot",
  );
  await expect(dot).toBeVisible();
  await expect(pct, "the stub's percentage, exactly — not a number computed from the archive").toHaveText("23%");

  // 2. The reset countdown (SPEC 252: "the time to reset pushed right") counts toward the stub's
  //    own reset time, ~4h out.
  await expect(reset).toHaveText(/^\d{1,2}h\d{2}m$/);

  // 3. The tooltip carries what the resting line cannot: the weekly figure (`buildBarTooltip`,
  //    client/app.ts), read from the stub's `weekly_all` entry, worded exactly as the function
  //    builds it.
  // The tooltip is our own element, not the browser's `title` — a native tooltip opens a second
  // after the pointer arrives, and everything the compact line cannot fit was behind that second
  // (2026-08-29). Hovering is what fills it, so the hover is part of the assertion.
  await meter.hover();
  await expect(page.locator("#bar-tip")).toBeVisible();
  // Rows, not a block of pre-formatted text: each figure is a `.tip-label` and a `.tip-value` so
  // the numbers line up in a column (2026-08-29, after the text version clipped its own first line).
  const rowValue = async (label) =>
    page.locator("#bar-tip .tip-row", { has: page.locator(`.tip-label:text-is("${label}")`) }).locator(".tip-value").first().textContent();
  // The panel opens on the pool list. There used to be an "active pool" section above it saying the
  // same thing again; the list already marks the active pool with its own arrow.
  await expect(page.locator("#bar-tip .tip-head").first()).toHaveText(/^all pools \(\d+ budgets\)$/);
  expect(await rowValue("Claude (Anthropic sub)")).toContain("23%");
  await expect(page.locator("#bar-tip")).toContainText("weekly");
  expect(await rowValue("↳ weekly")).toContain("41%");

  // 4. Severity drives the colour, not a threshold (SPEC 250: "severity comes from the response's
  //    own `severity` field"). The percentage does NOT move between these two writes — only
  //    `severity` does — so a meter that coloured itself off the percent cannot pass this.
  writeStub({ severity: "warning" });
  await new Promise((r) => setTimeout(r, 350));
  await page.clock.runFor(20_000);
  await expect.poll(async () => classesOf(meter)).toMatch(/\bwarm\b/);
  expect(await classesOf(meter)).not.toMatch(/\bhot\b/);
  expect(await classesOf(meter)).not.toMatch(/\bstale\b/);
  await expect(pct, "still the same 23% — only the colour moved").toHaveText("23%");

  writeStub({ severity: "critical" });
  await new Promise((r) => setTimeout(r, 350));
  await page.clock.runFor(20_000);
  await expect.poll(async () => classesOf(meter)).toMatch(/\bhot\b/);
  expect(await classesOf(meter)).not.toMatch(/\bwarm\b/);
  await expect(pct).toHaveText("23%");

  // The page stays usable while the badge cycles — this never became a meter with an app attached.
  await expect(page.locator("#composer-text")).toBeEditable();
  await expect(page.locator("#tree-body")).toBeVisible();

  // 5. A failed read never falls back to an estimate (SPEC 251) — it keeps showing the LAST GOOD
  //    reading, and says how old it is only once it is genuinely old. `LOOM_QUOTA_FAIL` cannot be flipped from inside a spec
  //    (it is read from the SERVER's own environment, fixed at boot), so the stale path is driven
  //    the way that IS available from here: a malformed body in the stub file, which `poll()`
  //    (server/usage.ts) treats exactly as a failed fetch — same `stale = true`, same
  //    last-good-kept behaviour.
  writeFileSync(STUB, "{not valid json");
  // The reading is SECONDS old here, and a reading that young is not stale — User, 2026-08-29:
  // *"2 minutes isnt really that stale"*. So the badge must stay exactly as it was: no grey, no
  // note, and the last good figure still on screen. `AGED_MS` (client/app.ts) is 8 minutes, which
  // a pin cannot wait out, so what this drives is the SILENCE, which is the behaviour he asked for.
  // The severity colour drops when the reading stops being current — that is what says the failure
  // arrived, since the badge no longer greys for one this young.
  await new Promise((r) => setTimeout(r, 350));
  await page.clock.runFor(20_000);
  await expect.poll(async () => classesOf(meter)).not.toMatch(/\bhot\b/);
  expect(await classesOf(meter)).not.toMatch(/\bstale\b/);
  expect(await classesOf(meter)).not.toMatch(/\bwarm\b/);
  // The number shown is still the LAST GOOD one (23, from the reading before the malformed write)
  // — never replaced by anything the archive could compute. Its AGE used to ride in the figure as
  // "23% (2m old)"; User, 2026-08-29: *"What is this 2m old - who cares"*. The staleness is still
  // said once it is old enough to matter, and the figure is the figure.
  await expect(pct, "last good reading — not a fresh archive estimate").toHaveText("23%");
  await meter.hover();
  await expect(page.locator("#bar-tip .tip-note")).toHaveCount(0);

  // 6. A good stub keeps it reading.
  writeStub({ severity: "normal" });
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
