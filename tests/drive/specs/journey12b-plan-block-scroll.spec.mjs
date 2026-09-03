/**
 * TEMPORARY evidence harness, deleted after the run. Not a pin.
 *
 * journey12's append case can only see the plan-block defect when the day's fixture happens to carry
 * a plan block whose file is unreadable — and the fixture's base is "the largest real transcript on
 * the machine", which changes between runs. This drives the same scenario with the block planted, so
 * the red and the green are about the code and not about which transcript was biggest today.
 */
import { expect, test } from "@playwright/test";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

test("evidence: an unreadable plan block above the reader must not move him on an append", async ({ page }) => {
  const { appendFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");

  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const store = process.env["LOOM_FIXTURE_OUT"] ?? join(root, "tests/fixture/projects");
  const file = join(store, "-fixture-project", "00000000-fixture-0000-000000000001.jsonl");

  const say = (text, n) =>
    appendFileSync(
      file,
      `${JSON.stringify({
        type: "assistant",
        uuid: `9999${String(n).padStart(4, "0")}-0000-0000-0000-000000000000`,
        parentUuid: null,
        timestamp: new Date().toISOString(),
        sessionId: "00000000-fixture-0000-000000000001",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
      })}\n`,
    );

  // A plan fence whose file is outside the server's readable root, so /api/file answers 403 — the
  // same shape as a plan citing a file since deleted.
  say("```plan\n/nowhere/at/all/unreadable-plan-2026-08-12.md\n```", 1);
  // Enough text under it that the block ends up well above the reader's viewport.
  for (let n = 0; n < 14; n++) say(`filler line ${n} — ${"the quick brown fox jumps over the lazy dog. ".repeat(8)}`, 10 + n);

  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator("#transcript-body")).toContainText("filler line 13", { timeout: 20_000 });
  await expect(page.locator(".plan-unreadable").first()).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(800);

  // Where the reader puts himself, and the row his eyes are on.
  const before = await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight - body.clientHeight - 260;
    const top = body.getBoundingClientRect().top;
    for (const row of body.querySelectorAll("[data-uuid]")) {
      const r = row.getBoundingClientRect();
      if (r.bottom > top) return { scrollTop: Math.round(body.scrollTop), uuid: row.dataset.uuid, offset: Math.round(r.top - top) };
    }
    return null;
  });
  // The block must really be above him, or this proves nothing.
  const above = await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    const block = document.querySelector(".plan-unreadable");
    return block.getBoundingClientRect().bottom < body.getBoundingClientRect().top;
  });
  expect(above, "the unreadable plan block must be above the reader, or the case is empty").toBe(true);

  say("evidence: the append that must not move him", 99);
  await expect(page.locator("#transcript-body")).toContainText("evidence: the append that must not move him", {
    timeout: 20_000,
  });
  await page.waitForTimeout(1200);

  const after = await page.evaluate(
    (want) => {
      const body = document.querySelector("#transcript-body");
      const top = body.getBoundingClientRect().top;
      const row = body.querySelector(`[data-uuid="${want}"]`);
      return { scrollTop: Math.round(body.scrollTop), offset: row ? Math.round(row.getBoundingClientRect().top - top) : null };
    },
    before.uuid,
  );

  expect(after.offset, `the row under his eyes stays where it was (was ${before.offset})`).toBe(before.offset);
  expect(after.scrollTop, `and the page did not move (was ${before.scrollTop})`).toBe(before.scrollTop);
});
