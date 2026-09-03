/**
 * A markdown TABLE in a record is readable: every column on screen, nothing clipped by the pane.
 *
 * User, 2026-08-28: "tables on project page dont render correctly ... i cant read your table
 * notes." The pane is `.pane-body { overflow-x: hidden }`, so a table wider than the column is cut
 * off with no way to reach the rest of it.
 */

import { expect, test } from "@playwright/test";

async function openParentRecord(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  // Entering a project with a live session lands on the session; the record is its row in the
  // open list (SPEC 113/202).
  await page.locator('.open-row[data-kind="record"]', { hasText: "Fixture parent project" }).click();
  await expect(page.locator("#record-body")).toContainText("Where it stands");
}

test("a record's table renders as a table, and no column is cut off", async ({ page }) => {
  await openParentRecord(page);

  const tables = page.locator("#record-body table");
  await expect(tables, "the markdown tables parsed as tables, not as pipes").toHaveCount(3);
  await expect(tables.nth(0).locator("thead th")).toHaveCount(3);
  await expect(tables.nth(1).locator("thead th")).toHaveCount(2);
  await expect(tables.nth(2).locator("thead th")).toHaveCount(4);

  // The reading test: the pane clips at its own width, so the last column's right edge has to be
  // inside it — for BOTH tables, and the second one holds cells that cannot wrap.
  for (const n of [0, 1, 2]) {
    const cut = await tables.nth(n).evaluate((table) => {
      const pane = document.querySelector("#record-body");
      const paneRight = pane.getBoundingClientRect().right;
      const cells = [...table.querySelectorAll("th, td")];
      const worst = Math.max(...cells.map((c) => c.getBoundingClientRect().right));
      return { over: Math.round(worst - paneRight), paneRight: Math.round(paneRight), worst: Math.round(worst) };
    });
    expect(cut.over, `table ${n + 1}: ${cut.worst}px right edge against a pane ending at ${cut.paneRight}px`)
      .toBeLessThanOrEqual(0);
  }

  await page.screenshot({ path: "/tmp/loom-tables.png", fullPage: false });
});

test("on a phone, a table is still readable end to end", async ({ page }) => {
  // Entered at desktop width, then narrowed: on a phone the rail is behind its toggle, and which
  // gesture opens a record is not this spec's subject — what the record LOOKS like at 390px is.
  await openParentRecord(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#record-body")).toContainText("Where it stands");

  const tables = page.locator("#record-body table");
  await expect(tables).toHaveCount(3);

  for (const n of [0, 1, 2]) {
    const cut = await tables.nth(n).evaluate((table) => {
      const pane = document.querySelector("#record-body");
      const paneRight = pane.getBoundingClientRect().right;
      const cells = [...table.querySelectorAll("th, td")];
      const worst = Math.max(...cells.map((c) => c.getBoundingClientRect().right));
      return { over: Math.round(worst - paneRight), reachable: table.scrollWidth > table.clientWidth };
    });
    expect(cut.over, `table ${n + 1} runs ${cut.over}px past the right edge of the pane`).toBeLessThanOrEqual(0);
  }

  await page.screenshot({ path: "/tmp/loom-tables-phone.png", fullPage: false });
});

/**
 * The file pane renders through `withSourceLines`, which is a different path from the record's —
 * and the one that was actually broken. It handed marked a bare `{ breaks }`, which REPLACES the
 * instance's options rather than merging with them, so GFM was off: a table lexed as a paragraph of
 * pipe characters, and the custom renderer went with it, so a rich block came out as plain code.
 */
test("a table in a NOTE renders as a table, not as a paragraph of pipes", async ({ page }) => {
  await openParentRecord(page);

  await page.locator('#record-body .chip[data-path$="table-note.md"]').click();
  const pane = page.locator("#file-body");
  await expect(pane).toContainText("A note with a table", { timeout: 10_000 });

  const tables = pane.locator("table");
  await expect(tables, "both tables in the note parsed as tables").toHaveCount(2);
  await expect(tables.nth(0).locator("thead th")).toHaveCount(3);
  await expect(tables.nth(0).locator("tbody tr")).toHaveCount(2);
  await expect(tables.nth(1).locator("thead th")).toHaveCount(2);
  // The two-sided half: no pipe row survived as prose anywhere in the pane.
  const pipes = await pane.evaluate((el) =>
    [...el.querySelectorAll("p")].filter((p) => /^\s*\|/.test(p.textContent ?? "")).length,
  );
  expect(pipes, "a table rendered as a paragraph of pipes").toBe(0);

  // The rest of GFM came back with it, and so did the custom renderer.
  await expect(pane.locator("del")).toHaveText("struck-through");
  await expect(pane.locator("pre code.language-plan"), "a rich block is not a plain code block").toHaveCount(0);

  // The line map the pane exists for still works: a table is one block, at the line it starts on.
  await expect(tables.nth(0)).toHaveAttribute("data-line", "5");

  await page.screenshot({ path: "/tmp/loom-note-tables.png", fullPage: false });
});
