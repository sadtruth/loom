/**
 * Closing a project from its own record tab, driven end to end (SPEC 65–66).
 *
 * User, 2026-08-06: *"this subproject is done for now — but i dont have the button to mark project
 * done."* The task box closes work items; this closes the project holding them, and the gate is the
 * same one level up — a project closes on a VERDICT, not on a finished task list.
 *
 * Narrow assertions would miss what matters: every step writes the real markdown file, so the spec
 * leaves the record and comes back, and asserts what the FILE gave back rather than the DOM it left
 * behind. It runs last on purpose — it moves the fixture record's status, and the earlier specs read
 * it.
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

const VERDICT = "the tree and the task rows landed; deriving a project's sessions did not";

async function openTheRecord(page) {
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  // The record's row in the open list (SPEC 202) — it used to be a tab in the reading column.
  await page.locator('.open-row[data-kind="record"]', { hasText: "Fixture parent project" }).click();
}

test("a project is closed from its record tab, and only on a verdict", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await openTheRecord(page);

  // ── the control sits next to the status it moves ────────────────────
  const chip = page.locator(".record-status");
  await expect(chip).toHaveText("active");
  const close = page.locator(".record-act", { hasText: "mark done" });
  await expect(close).toBeVisible();

  // ── done is a gate: the status does not move until a verdict exists ──
  await close.click();
  const form = page.locator(".record-form");
  await expect(form).toBeVisible();
  await expect(chip).toHaveText("active");

  await form.locator(".record-save").click();
  await expect(form.locator(".record-form-text")).toHaveClass(/bad/);
  await expect(chip).toHaveText("active");

  await form.locator(".record-form-text").fill(VERDICT);
  await form.locator(".record-save").click();

  await expect(chip).toHaveText("done");
  await expect(page.locator("#record-body")).toContainText(VERDICT);
  // The verdict is written where the skill keeps it — inside Where it stands, not at the file's end.
  await expect(page.locator("#record-body")).toContainText("Verdict");

  // ── the write is in the FILE, not just on screen ────────────────────
  await page.locator(".tree-item.general").click();
  await openTheRecord(page);
  await expect(page.locator(".record-status")).toHaveText("done");
  await expect(page.locator("#record-body")).toContainText(VERDICT);
  // The tree carries the closed status too, so a done project reads as done from the rail.
  await expect(page.locator(".tree-item", { hasText: "Fixture parent project" }).first()).toHaveClass(
    /status-done/,
  );
  // Closing the project left its work items exactly as they were.
  await expect(page.locator(".task").first().locator(".task-box")).toBeVisible();

  // ── a close is not a one-way door, and reopening keeps the verdict ──
  await page.locator(".record-act", { hasText: "reopen" }).click();
  await expect(page.locator(".record-status")).toHaveText("active");
  await expect(page.locator("#record-body")).toContainText(VERDICT);
  await page.locator(".tree-item.general").click();
  await openTheRecord(page);
  await expect(page.locator(".record-status")).toHaveText("active");

  expect(errors, "no page errors across the close flow").toEqual([]);
});
