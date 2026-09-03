/**
 * Hand creation and rename, driven (SPEC §Create-and-rename): a record born from the panel's
 * `+ new project` row, a subproject born from a row's context menu, a rename from the record tab's
 * own title, and the ripple — the parent's `[>]` line names the same object, so it changes in the
 * same save. Plus `copy link`, read back from the real clipboard.
 */

import { expect, test } from "@playwright/test";
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

// This spec MINTS records, and it runs before journey4's exact-count tree assertions (lexicographic
// order). It cleans up what it created — same slotted records dir the config gives the server.
// The config publishes the real path; deriving it here from LOOM_PINS alone missed the per-worker
// suffix and the cleanup silently removed nothing.
const SLOT = process.env["LOOM_PINS"] ?? "";
function recordsDir(testInfo) {
  const index = testInfo?.parallelIndex ?? Number(process.env["TEST_PARALLEL_INDEX"] ?? 0);
  const slotName = `.records${SLOT !== "" ? `-${SLOT}` : ""}-w${index}`;
  return join(fileURLToPath(new URL("../../..", import.meta.url)), "tests", "fixture", slotName);
}

test.afterAll(async ({}, testInfo) => {
  const dir = recordsDir(testInfo);
  for (const slug of ["fresh-idea", "holder", "intruder-record", "second-intruder"]) {
    await rm(join(dir, slug), { recursive: true, force: true });
  }
});

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

test("create from the panel, subproject and rename from the row menu, ripple into the parent", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // ── `+ new project`: a root record from a title ─────────────────
  await page.locator(".tree-more.create").click();
  const rootInput = page.locator(".tree-input input");
  await expect(rootInput).toBeFocused();
  await rootInput.fill("Fresh idea");
  await rootInput.press("Enter");
  // The record opens; the tree carries the new row; the record is an honest framing stub.
  const freshRow = page.locator(".tree-item", { hasText: "Fresh idea" });
  await expect(freshRow).toHaveCount(1);
  await expect(page.locator(".open-row.on")).toContainText("Fresh idea");
  await expect(page.locator("#record-body")).toContainText("Write the frame with User");
  // Esc must not mint a record: open the input again and abandon it.
  await page.locator(".tree-more.create").click();
  await page.locator(".tree-input input").press("Escape");
  await expect(page.locator(".tree-input")).toHaveCount(0);
  await expect(page.locator(".tree-item", { hasText: "Fresh idea" })).toHaveCount(1);

  // ── the row menu: + subproject ──────────────────────────────────
  await freshRow.click({ button: "right" });
  const menu = page.locator(".tree-menu");
  await expect(menu).toBeVisible();
  await menu.getByText("+ subproject").click();
  const childInput = page.locator(".tree-input input");
  await childInput.fill("Deeper cut");
  await childInput.press("Enter");
  await expect(page.locator(".open-row.on")).toContainText("Deeper cut");
  // Nested under the parent, not beside it.
  const childRow = page.locator(".tree-item", { hasText: "Deeper cut" });
  await expect(childRow).toHaveCount(1);
  const parentPad = await freshRow.evaluate((el) => Number.parseInt(el.style.paddingLeft, 10));
  const childPad = await childRow.evaluate((el) => Number.parseInt(el.style.paddingLeft, 10));
  expect(childPad).toBeGreaterThan(parentPad);
  // The parent's own record gained the `[>]` line.
  await freshRow.click();
  await expect(page.locator("#record-body")).toContainText("Deeper cut");

  // ── rename from the record tab's title, ripple asserted in the FILE's parent ──
  await childRow.click();
  await page.locator("#record-body h1.record-title").click();
  const titleInput = page.locator("#record-body .record-title-input");
  await titleInput.fill("Deeper cut renamed");
  await titleInput.press("Enter");
  await expect(page.locator(".open-row.on")).toContainText("Deeper cut renamed", { timeout: 10_000 });
  await expect(page.locator(".tree-item", { hasText: "Deeper cut renamed" })).toHaveCount(1);
  await freshRow.click();
  await expect(page.locator("#record-body")).toContainText("Deeper cut renamed");

  // ── rename from the row menu ────────────────────────────────────
  const renamedRow = page.locator(".tree-item", { hasText: "Deeper cut renamed" });
  await renamedRow.click({ button: "right" });
  await page.locator(".tree-menu").getByText("rename", { exact: true }).click();
  const rowInput = page.locator(".tree-input input");
  await expect(rowInput).toHaveValue("Deeper cut renamed");
  await rowInput.fill("Final name");
  await rowInput.press("Enter");
  await expect(page.locator(".tree-item", { hasText: "Final name" })).toHaveCount(1);
  await expect(page.locator("#record-body")).toContainText("Final name");

  // ── copy link: the absolute record path lands on the clipboard ──
  await page.locator(".tree-item", { hasText: "Final name" }).click({ button: "right" });
  await page.locator(".tree-menu").getByText("copy link").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/deeper-cut\/project\.md$/); // the slug is an address: rename never moves it

  expect(errors).toEqual([]);
});

/**
 * A title being typed survives what another session is doing (SPEC 146).
 *
 * User, 2026-08-10: *"i start entering the title of the new subproject — the input disapears and
 * i have to start anew if there was some other session doing some work."* The tree is a full redraw
 * (`ui.tree.replaceChildren()`), the input was raw DOM appended beside it, and the records poll
 * fires every 4s — so anything typed slower than that was lost.
 *
 * The intruder is a REAL foreign write (`POST /api/record/create`), which is what a session framing
 * a project does, and the pin is two-sided: the intruder's row must APPEAR — suppressing the redraw
 * while an input is open would keep the text and re-break the thing the poll exists for.
 */
test("a title being typed survives a record another writer creates underneath it", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // A parent to hang the subproject off.
  await page.locator(".tree-more.create").click();
  await page.locator(".tree-input input").fill("Holder");
  await page.locator(".tree-input input").press("Enter");
  const holderRow = page.locator(".tree-item", { hasText: "Holder" });
  await expect(holderRow).toHaveCount(1);

  // ── typing a subproject title, slowly ───────────────────────────
  await holderRow.click({ button: "right" });
  await page.locator(".tree-menu").getByText("+ subproject").click();
  const input = page.locator(".tree-input input");
  await input.fill("Half typed child");
  const pad = await page.locator(".tree-input").evaluate((el) => Number.parseInt(el.style.paddingLeft, 10));

  // ── another writer lands a record; the tree must take it ────────
  await page.evaluate(() =>
    fetch("/api/record/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Intruder record", parent: null }),
    }),
  );
  await expect(page.locator(".tree-item", { hasText: "Intruder record" })).toHaveCount(1, { timeout: 15_000 });

  // ── and what was being typed is still there, still usable ───────
  await expect(input, "the typed title survived the redraw").toHaveValue("Half typed child");
  await expect(input, "and the caret is still in it — the next keystroke is not lost").toBeFocused();
  const padAfter = await page.locator(".tree-input").evaluate((el) => Number.parseInt(el.style.paddingLeft, 10));
  expect(padAfter, "still nested under its parent, not reparented to the root").toBe(pad);
  expect(padAfter).toBeGreaterThan(
    await holderRow.evaluate((el) => Number.parseInt(el.style.paddingLeft, 10)),
  );

  // Enter still commits the title that was typed BEFORE the redraw.
  await input.press("Enter");
  await expect(page.locator(".open-row.on")).toContainText("Half typed child", { timeout: 10_000 });
  await expect(page.locator(".tree-item", { hasText: "Half typed child" })).toHaveCount(1);

  // ── the same rule for a rename in flight ────────────────────────
  await page.locator(".tree-item", { hasText: "Half typed child" }).click({ button: "right" });
  await page.locator(".tree-menu").getByText("rename", { exact: true }).click();
  const renaming = page.locator(".tree-input input");
  await renaming.fill("Renamed mid poll");
  await page.evaluate(() =>
    fetch("/api/record/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Second intruder", parent: null }),
    }),
  );
  await expect(page.locator(".tree-item", { hasText: "Second intruder" })).toHaveCount(1, { timeout: 15_000 });
  await expect(renaming, "a rename in flight survives it too").toHaveValue("Renamed mid poll");
  await renaming.press("Enter");
  await expect(page.locator(".tree-item", { hasText: "Renamed mid poll" })).toHaveCount(1, { timeout: 10_000 });

  expect(errors).toEqual([]);
});
