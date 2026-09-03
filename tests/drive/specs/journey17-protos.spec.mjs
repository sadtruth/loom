/**
 * The drawer's prototypes surface, driven end to end (SPEC 134–137).
 *
 * The need is provenance both ways: a prototype row must lead BACK to the conversation that
 * introduced it (the design context is the artifact's meaning), and OUT to a full browser tab
 * (a 300px column is no place to click a mockup). Scope is the record plus its children, never a
 * parent — so the child's drawer is asserted from the child's side too.
 */

import { expect, test } from "@playwright/test";

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource.*\b(403|404|413|415)\b/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test("prototypes fold under their latest, jump to their introduction, and open in a tab", async ({ page, context }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // ── outside a project the surface has nothing to be about ────────
  await expect(page.locator("#drawer-protos")).toBeDisabled();

  // ── the parent's drawer: its own chain first, the child's file after ──
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();
  const protosPick = page.locator("#drawer-protos");
  await expect(protosPick).toBeEnabled();
  await protosPick.click();
  await expect(protosPick).toHaveClass(/on/);

  const groups = page.locator("#drawer-body .art-group");
  await expect(groups.first()).toContainText("Fixture parent project — this record");
  await expect(groups.nth(1)).toContainText("Fixture child project");
  // Three files total, and the badge says so.
  await expect(page.locator("#drawer-count")).toHaveText("3");

  // The chain: v2 leads with its badge, v1 sits folded under it named by version.
  const head = page.locator("#drawer-body .proto").filter({ hasText: "fixture-widget" }).first();
  await expect(head.locator(".proto-v")).toHaveText("v2");
  const older = page.locator("#drawer-body .proto-chain .proto-old");
  await expect(older).toHaveCount(1);
  await expect(older.first()).toContainText("v1");

  // ── ↗ opens the prototype ITSELF, in a tab of its own ────────────
  await head.hover();
  const [popup] = await Promise.all([context.waitForEvent("page"), head.locator(".proto-open").click()]);
  await expect(popup.locator("body")).toContainText("fixture widget v2, the bigger one");
  expect(popup.url()).toContain("raw=1");
  await popup.close();

  // ── a row leads back to the message that introduced the file ─────
  await head.click();
  const anchor = page.locator("#m-44444444-0000-0000-0000-000000000004");
  await expect(anchor).toBeVisible({ timeout: 10_000 });
  await expect(anchor).toHaveClass(/jumped/);
  await expect(anchor).toBeInViewport();
  // The jump is INTO the conversation, so the record tab must not have swallowed the screen.
  await expect(page.locator("#record-body")).toBeHidden();

  // ── a file nothing embeds degrades to a plain answer, not a hang ─
  await page.locator("#drawer-body .proto").filter({ hasText: "child-proto" }).first().click();
  await expect(page.locator("#toast")).toContainText("no session embeds this prototype yet");

  // ── the child's drawer never shows its parent's prototypes ───────
  // No second click on the pick: an explicit pick persists across records (a second click would
  // TOGGLE it off), so walking into the child keeps the surface and only narrows its scope.
  await page.locator(".tree-item", { hasText: "Fixture child project" }).first().click();
  await expect(page.locator("#drawer-protos")).toHaveClass(/on/);
  const childRows = page.locator("#drawer-body .proto");
  await expect(childRows).toHaveCount(1);
  await expect(childRows.first()).toContainText("child-proto");
  await expect(page.locator("#drawer-body")).not.toContainText("fixture-widget");

  expect(errors, errors.join("\n")).toEqual([]);
});
