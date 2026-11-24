/**
 * P40 — the limits panel draws every window a pool has, not just the one the badge rests on.
 *
 * The panel draws one row per pool and, under it, a row per window. The Google pools always had
 * both. The pool the badge points at on this box is Command Code, whose subscription answers THREE
 * windows — monthly credits, a rolling 5-hour cap and a rolling weekly cap — and all three belong
 * in the panel, because any one of them can be the one that runs out.
 *
 * The numbers come from `LOOM_QUOTA_STUB_COMMANDCODE`, seeded in playwright.config.mjs at 23% of
 * the 5-hour cap, 8% of the week and 6% of the month — three different figures on purpose, so a
 * panel that drew one of them three times cannot pass this. The three rows must also sit under the
 * pool's own row, in that order, and nothing may be clipped: the drawer used to pin the panel to
 * ~300px and truncate the label on every row (2026-09-02: *"i can barely read text there - it's
 * very much cut"*).
 */

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const LOOM_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const PROJECT_KEY = LOOM_ROOT.replace(/[^A-Za-z0-9-]/g, "-");

test("limits panel: the Command Code pool carries its monthly, five-hour AND weekly windows", async ({ page }) => {
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

  // The three pools the panel draws now: Command Code and the two Google ones.
  await expect(tip.locator(".tip-head").first()).toHaveText(/^all pools \(3 budgets\)$/);

  // The pool row itself.
  const commandCodeRow = tip.locator(".tip-row", { hasText: "Command Code" });
  await expect(commandCodeRow).toHaveCount(1);

  // Its three windows, each with the figure the stub seeded.
  const rows = tip.locator(".tip-row.sub-row");
  const monthly = rows.filter({ hasText: "monthly" }).first();
  const fiveHour = rows.filter({ hasText: "5h window" }).first();
  const weekly = rows.filter({ hasText: "weekly" }).first();

  await expect(monthly.locator(".tip-value")).toContainText("6%");
  await expect(fiveHour.locator(".tip-value")).toContainText("23%");
  await expect(weekly.locator(".tip-value")).toContainText("8%");

  // Nothing in the panel is cut off. Measured rather than eyeballed: an element whose content is
  // wider than its box is being clipped, whatever the ellipsis looks like.
  const clipped = await tip.evaluate((el) =>
    [...el.querySelectorAll(".tip-label")]
      .filter((n) => n.scrollWidth > n.clientWidth + 1)
      .map((n) => n.textContent),
  );
  expect(clipped, "no label in the panel is clipped").toEqual([]);

  // And they belong to the Command Code pool — immediately after its row, before any other pool.
  // Read as a flat list, because the panel is a flat list.
  const labels = await tip.locator(".tip-row .tip-label").allInnerTexts();
  const commandCodeAt = labels.findIndex((l) => l.includes("Command Code"));
  expect(commandCodeAt, "the Command Code pool row is in the panel").toBeGreaterThanOrEqual(0);
  expect(labels[commandCodeAt + 1], "the monthly window sits under the Command Code row").toContain("monthly");
  expect(labels[commandCodeAt + 2], "then the 5-hour window").toContain("5h window");
  expect(labels[commandCodeAt + 3], "then the weekly window").toContain("weekly");
});
