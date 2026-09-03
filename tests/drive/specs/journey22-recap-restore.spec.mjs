/**
 * The block after loom itself restarted (SPEC §Recap, requirement 180), driven end to end.
 *
 * The state a restart leaves is not something this suite can produce by restarting — Playwright owns
 * the server for the whole run. It is produced by the FIXTURE instead: a record whose ledger already
 * holds an entry, in a server process that has never recapped it. Memory empty, file written — which
 * is exactly what the client hits after `systemctl restart loom`, and the reason this record exists
 * separately from the recap spec's.
 *
 * The two assertions that can fail for real: the superseded entry must never reach the screen, and a
 * block that came back from the file must not be delivered to the model a second time.
 * Edited 2026-08-26, SPEC 252: the #t-meta button is gone. `loom-view` still drives the render
 * (114), so meta rows are now reached by writing the key and reloading, not by clicking.
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

async function enterTheRestoreProject(page) {
  await page.locator(".tree-item", { hasText: "Fixture restored recap project" }).first().click();
  // The chat row of the open list — what `.tab-session-label` named before the layout build
  // moved the strip out of the centre (SPEC 202).
  await page.locator('.open-row[data-kind="session"]').click();
}

/**
 * Requirement 206. The block names one seam in one record, so walking into another record must not
 * bring it along — he found it on a project created minutes earlier, showing another build's recap.
 *
 * This record is the one with a block on DISK and no recap in this process, so what is under test is
 * exactly what a fresh screen draws; the project walked into has no ledger of its own.
 *
 * It runs FIRST in this file on purpose: the test below refuses the block, and a refusal is written
 * to `state/recap.json`, which outlives the page. Ordered the other way, this one opens the record
 * and finds nothing to walk away from.
 */
test("the block does not follow him into another project", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await enterTheRestoreProject(page);
  await expect(page.locator(".recap")).toBeVisible({ timeout: 15_000 });

  await page.locator(".tree-item", { hasText: "Fixture child project" }).first().click();
  await expect(page.locator(".recap")).toHaveCount(0, { timeout: 10_000 });
  // Not merely late: it must still be gone once that project has opened and its session attached,
  // which is when the restore path would have put the old block back.
  await page.waitForTimeout(2_000);
  await expect(page.locator(".recap")).toHaveCount(0);

  // And the walk does not destroy it — the record it belongs to still shows it.
  await enterTheRestoreProject(page);
  await expect(page.locator(".recap")).toBeVisible({ timeout: 15_000 });

  expect(errors).toEqual([]);
});

test("the block comes back from the ledger, once, and only where it means something", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await enterTheRestoreProject(page);

  // Nothing was recapped in this process: whatever is on screen was read off disk.
  const block = page.locator(".recap");
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block).toContainText("where you left off");
  await expect(block).toContainText("RESTORED");
  // Requirement 173's second half, which until now was proved only about a function nothing called:
  // the ledger holds an older entry for the same car, and it must not be on screen.
  await expect(block).not.toContainText("SUPERSEDED");
  // His call, 2026-08-13: a re-read block says so rather than posing as the delivered one.
  await expect(block).toContainText("re-read from the ledger");

  // Scenario 3: the car BEFORE an old car is not "where you left off". Same ledger, same record —
  // only the seat changes, so a restore that ignored the train would still be showing the block.
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  await page.locator("#select-claude").selectOption({ index: 1 });
  await expect(page.locator(".recap")).toHaveCount(0, { timeout: 10_000 });
  await page.locator("#select-claude").selectOption({ index: 0 });
  await expect(page.locator(".recap")).toBeVisible({ timeout: 10_000 });

  // Requirement 180's other half: restored is not delivered. The reminder rode his first message
  // before the restart, or never — so the next message must carry nothing, and the stub answers by
  // quoting its whole prompt back, which is what makes the absence observable.
  await page.locator("#composer-text").fill("so where were we");
  await page.locator("#composer-send").click();
  await expect(page.locator(".msg.assistant").last()).toBeVisible({ timeout: 30_000 });
  // The #t-meta button is gone (SPEC 252); `loom-view` still drives the render (114), so meta rows
  // are reached by writing the key and reloading. The session is real (it was just sent to), so a
  // reload reads it straight off disk. Nothing after this cares whether meta stays on, so there is
  // no toggle-off reload to match it.
  await page.evaluate(() => {
    localStorage.setItem(
      "loom-view",
      JSON.stringify({ doc: false, thinking: false, meta: true, full: false }),
    );
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  const said = page.locator(".msg.user", { hasText: "so where were we" }).first();
  await expect(said).toBeVisible();
  await expect(said).not.toContainText("Recap of the previous session");
  await expect(said).not.toContainText("RESTORED");

  // Requirement 176 through the restore path: a refusal is read from `state/recap.json` before the
  // ledger is, so the block that survives a restart does not also survive a dismiss.
  await page.locator(".recap .recap-x").click();
  await expect(page.locator(".recap")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".recap")).toHaveCount(0);

  expect(errors).toEqual([]);
});
