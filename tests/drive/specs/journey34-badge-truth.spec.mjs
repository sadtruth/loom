/**
 * The "new" badge requires an actual answer, not a default (SPEC step 4, session-truth Next 2).
 *
 * `recordIsNew` used to read `state.activity[record.path] ?? []` — a path `/api/activity` has not
 * answered YET reads exactly like one it answered with nothing. User, twice (items 53, 63): a
 * busy project wears "new" for the whole first poll interval, every time the page loads.
 *
 * This holds the real `/api/activity` request open (not a faked response — the server's own
 * `answered` field, SPEC requirement 237, is what the fix is built on) and asserts the badge is
 * absent for EVERY record while it is pending, then present for a genuinely session-less one once
 * it lands.
 */

import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

let createdDir = null;
test.afterAll(async () => {
  if (createdDir === null) return;
  await rm(createdDir, { recursive: true, force: true });
  // `scanRecords`'s cache (server/records.ts) is never invalidated by a filesystem delete outside
  // its own write routes — it only notices past its TTL (2,000ms). Deleting and moving straight to
  // the NEXT spec file left that file's very first `/api/records` read serving this record back
  // from a stale cache entry, which is how journey4-records' hardcoded row count went from flaky in
  // isolation to reliably wrong once this file started sorting immediately before it (found
  // 2026-08-24, running journey34 then journey4-records back to back: journey4 saw 12 rows instead
  // of 6, reproducible, and reproducible too with the unmodified, pre-existing journey16-create in
  // the same adjacent slot — a pre-existing gap, not something this test's own logic caused). This
  // wait is cheap insurance so the NEXT file's first read is never the stale one.
  await new Promise((resolve) => setTimeout(resolve, 2_200));
});

test("no record shows 'new' before /api/activity answers; a genuinely empty one does after", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // ── mint a record with created:today and no sessions — the one case the badge should show, but
  // only once an answer actually says so ──
  await page.locator(".tree-more.create").click();
  const input = page.locator(".tree-input input");
  await input.fill("Badge truth window");
  const createResponse = page.waitForResponse((r) => r.url().includes("/api/record/create") && r.request().method() === "POST");
  await input.press("Enter");
  const created = await (await createResponse).json();
  expect(typeof created.child).toBe("string");
  // The record's own directory — always safe to remove, wherever the record root put it.
  createdDir = dirname(created.child);
  await expect(page.locator(".tree-item", { hasText: "Badge truth window" })).toHaveCount(1);

  // ── hold the REAL request open: a reload's boot fetch is the exact race User reported ──
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/activity", async (route) => {
    await gate;
    try {
      await route.continue();
    } catch {
      // A second in-flight request to the same URL (the periodic poll firing right behind the boot
      // fetch) can already be resolved by the time this one's gate opens — not this test's concern.
    }
  });

  await page.reload();
  const row = page.locator(".tree-item", { hasText: "Badge truth window" });
  await expect(row).toHaveCount(1, { timeout: 20_000 });

  // Pending: no row anywhere carries the badge, including the fresh one that will genuinely earn
  // it — this is the exact assertion that fails on unpatched code, where the badge shows on load.
  expect(await page.locator(".tree-dot.new").count()).toBe(0);

  // ── release, and the SAME record now earns the badge from a real answer ──
  release();
  await page.unroute("**/api/activity");
  await expect(row.locator(".tree-dot.new")).toBeVisible({ timeout: 5_000 });
});
