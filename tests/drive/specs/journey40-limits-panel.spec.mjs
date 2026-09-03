/**
 * P40 — the limits panel shows BOTH Anthropic windows, not just the five-hour one.
 *
 * The panel draws one row per pool and, under it, a row per window. The Google pools always had
 * both; the Anthropic pool had a branch of its own that drew the headline and stopped, so the
 * WEEKLY figure — the one that actually runs out over a working week — appeared nowhere in the
 * panel, though `server/budgets.ts` has always sent it (User, 2026-09-02: *"fix the limit panel
 * so it shows also weekly anthropic limit, you missed it"*).
 *
 * The numbers come from `LOOM_QUOTA_STUB`, seeded in playwright.config.mjs at a `session` window of
 * 23% and a `weekly_all` window of 41% — two different numbers on purpose, so a panel that drew the
 * five-hour figure twice cannot pass this. Against the pre-fix client the weekly row is absent
 * entirely and the `↳ weekly` locator reads 0.
 */

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const LOOM_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const PROJECT_KEY = LOOM_ROOT.replace(/[^A-Za-z0-9-]/g, "-");

test("limits panel: the Claude pool carries its five-hour AND its weekly window", async ({ page }) => {
  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // The panel is drawn from `/api/budgets`; the badge only appears once a reading has arrived.
  const meter = page.locator("#bar-meter");
  await expect(meter).toBeVisible({ timeout: 25_000 });
  await expect(page.locator("#micro-strip")).toBeVisible({ timeout: 25_000 });

  // Click pins the panel open, so the assertions below are not racing a pointerleave.
  await page.locator("#micro-strip").click();
  const tip = page.locator("#bar-tip");
  await expect(tip).toBeVisible();

  // The pool row itself.
  const claudeRow = tip.locator(".tip-row", { hasText: "Claude (Anthropic sub)" });
  await expect(claudeRow).toHaveCount(1);

  // Its two windows, each with the figure the stub seeded. 23 and 41 are different numbers, which
  // is what makes this two-sided: a panel drawing the five-hour figure twice cannot pass.
  const rows = tip.locator(".tip-row.sub-row");
  const fiveHour = rows.filter({ hasText: "5h window" }).first();
  const weekly = rows.filter({ hasText: "weekly" }).first();

  await expect(fiveHour.locator(".tip-value")).toContainText("23%");
  await expect(weekly.locator(".tip-value")).toContainText("41%");

  // Nothing in the panel is cut off. It used to be pinned to the drawer's ~300px and truncate the
  // LABEL on every row, so the pools read "C…" and "Ju…" and an unavailable pool showed a reason
  // with no way to tell whose it was (2026-09-02: *"i can barely read text there - it's very much
  // cut"*). Measured rather than eyeballed: an element whose content is wider than its box is
  // being clipped, whatever the ellipsis looks like.
  const clipped = await tip.evaluate((el) =>
    [...el.querySelectorAll(".tip-label")]
      .filter((n) => n.scrollWidth > n.clientWidth + 1)
      .map((n) => n.textContent),
  );
  expect(clipped, "no label in the panel is clipped").toEqual([]);

  // And they belong to the Claude pool — they are the rows immediately after it, before any other
  // pool row. Read as a flat list, because the panel is a flat list.
  const labels = await tip.locator(".tip-row .tip-label").allInnerTexts();
  const claudeAt = labels.findIndex((l) => l.includes("Claude (Anthropic sub)"));
  expect(claudeAt, "the Claude pool row is in the panel").toBeGreaterThanOrEqual(0);
  expect(labels[claudeAt + 1], "the 5-hour window sits under the Claude row").toContain("5h window");
  expect(labels[claudeAt + 2], "the weekly window sits under it").toContain("weekly");
});
