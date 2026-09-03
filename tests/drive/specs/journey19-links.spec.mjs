/**
 * Smart links, driven end to end (SPEC 139–142).
 *
 * User's two complaints, 2026-08-09: three chips in one list all reading "project.md", and links
 * that do not open. So this walks the message that names every kind — reads what each chip SAYS,
 * then clicks it and asserts where it landed — because a label rule proven only in unit tests is a
 * rule about strings, and the failure was about a reader looking at a list.
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

/** The chips inside the fixture's kinds message — scoped, so the rest of the transcript cannot lie for us. */
function kindChips(page) {
  return page.locator(".msg", { hasText: "Two records:" }).last().locator(".chip");
}

/**
 * Click a chip in the TRANSCRIPT while a file may be up.
 *
 * A file IS the centre now (SPEC 189), so the chat is a row away rather than a pane away: the chat
 * row brings the transcript back and the file stays open behind it, which is the whole point of the
 * open set. It used to be a column beside the chat, where every click could be made blind.
 */
async function clickChip(page, chip) {
  await page.locator('.open-row[data-kind="session"]').click();
  await expect(page.locator("#chat-area")).toBeVisible();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
}

test("a chip says where it goes, and clicking it lands there", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();

  const chips = kindChips(page);
  await expect(chips.first()).toBeVisible({ timeout: 20_000 });

  // ── 1 · records say their titles, and the same word is never used twice ──
  const record = chips.filter({ hasText: "Fixture parent project" }).first();
  await expect(record).toHaveClass(/rec/);
  await expect(record).toHaveAttribute("data-path", /project\.md$/);
  const childRecord = chips.filter({ hasText: /Fixture child project/ }).first();
  await expect(childRecord).toHaveClass(/rec/);
  // The defect itself: no chip in this message may READ as the filename.
  await expect(chips.filter({ hasText: /^project\.md$/ })).toHaveCount(0);

  // ── 2 · one filename in two projects: the owner suffix disambiguates ──
  const notes = chips.filter({ hasText: "notes.md" });
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0).locator(".owner")).toHaveText(/Fixture parent project/);
  await expect(notes.nth(1).locator(".owner")).toHaveText(/Fixture child project/);
  // Two-sided: a filename that appears ONCE carries no suffix, or the suffix means nothing.
  await expect(chips.filter({ hasText: "lines.txt" }).first().locator(".owner")).toHaveCount(0);

  // ── a record chip enters the project, like its tree row ───────────
  await childRecord.click();
  // The tree's own selection is the proof it entered the project rather than merely showing a file:
  // the current row IS the child, and the file pane stayed shut.
  await expect(page.locator(".tree-item.current")).toContainText(/Fixture child project/, { timeout: 10_000 });
  await expect(page.locator("#layout")).not.toHaveClass(/file-open/);
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(kindChips(page).first()).toBeVisible({ timeout: 20_000 });

  // ── 3 · a directory opens as a LISTING of chips, and walks ────────
  await clickChip(page, kindChips(page).filter({ hasText: "mockups/" }).first());
  const pane = page.locator("#file-body");
  await expect(pane.locator(".file-dir")).toBeVisible({ timeout: 10_000 });
  await expect(pane.locator(".file-dir-row .chip", { hasText: "fixture-widget-v2-bigger-2026-08-02.html" })).toBeVisible();
  // A row is a real chip: clicking one reads the file, without leaving loom.
  //
  // REVISED 2026-08-24 (SPEC 241). This used to assert the widget's MARKUP appeared as text, which
  // is the bug the audit found 24 times over: an `.html` file is a PAGE now, so the evidence is the
  // frame and the document inside it rather than a listing of its source.
  await pane.locator(".file-dir-row .chip").filter({ hasText: "fixture-widget-2026-08-01.html" }).first().click();
  const framed = pane.locator(".embed iframe");
  await expect(framed).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => (await framed.getAttribute("srcdoc")) ?? "", { timeout: 10_000 })
    .toContain("fixture widget");
  await expect(pane.locator(".file-text"), "and never as its own markup").toHaveCount(0);

  // ── 4 · a place inside a file: the heading, then the line ─────────
  const heading = kindChips(page).filter({ hasText: "§ out-of-scope" }).first();
  await expect(heading).toHaveClass(/place/);
  // The destination the server is asked for never carries the suffix.
  await expect(heading).toHaveAttribute("data-path", /headings\.md$/);
  await expect(heading).toHaveAttribute("data-place", "#out-of-scope");
  await clickChip(page, heading);
  const landedHeading = pane.locator(".file-md h2", { hasText: "Out of scope" });
  await expect(landedHeading).toBeVisible({ timeout: 10_000 });
  await expect(landedHeading).toHaveClass(/jumped/);

  const line = kindChips(page).filter({ hasText: "lines.txt:3" }).first();
  await clickChip(page, line);
  const landedLine = pane.locator(".file-line");
  await expect(landedLine).toBeVisible({ timeout: 10_000 });
  await expect(landedLine).toHaveText(/third line/);

  // ── a `~` path opens, which is the whole of SPEC 142 ──────────────
  const tilde = kindChips(page).filter({ hasText: "ARCHITECTURE.md" }).first();
  await expect(tilde).toHaveAttribute("data-path", /^~\//);
  await clickChip(page, tilde);
  await expect(pane.locator(".file-md, .file-text")).toContainText("loom", { timeout: 10_000 });
  await expect(pane.locator(".file-note")).toHaveCount(0); // no "400 absolute path required"

  // ── a RELATIVE path climbs to the ancestor that holds it (SPEC 143) ──
  // Shipped broken on 2026-08-10: joined to the session's cwd, which is a record directory, and
  // 400'd on the first click User tried. The pin is the file's real content in the pane PLUS the
  // resolved absolute path in the header — "no error note" alone would pass on an empty pane.
  const rel = kindChips(page).filter({ hasText: "markdown.ts" }).first();
  await expect(rel).toHaveAttribute("data-path", "client/markdown.ts");
  await clickChip(page, rel);
  await expect(pane.locator(".file-text, .file-md")).toContainText("chip", { timeout: 10_000 });

  // ── the same file reads as CODE, and still reads as itself (SPEC 144) ──
  // A .ts file open in the pane is the case User raised: highlighted, numbered, unchanged.
  const rows = pane.locator(".file-text .file-row");
  await expect(rows.first()).toBeVisible();
  await expect(pane.locator(".file-text .hljs-comment").first()).toBeVisible(); // the file opens on a doc comment
  await expect(pane.locator(".file-text .hljs-keyword").first()).toBeVisible();
  await expect(rows.nth(2)).toHaveAttribute("data-line", "3");
  // The invariant, driven rather than argued: the rows' text IS the file, in order. The gutter is a
  // ::before and must not appear in it — a number leaking into the text would break every copy.
  const shownText = await pane.locator(".file-text code").evaluate((node) => node.textContent);
  expect(shownText.startsWith("/**\n * Markdown -> sanitised DOM")).toBe(true);
  expect(shownText).not.toMatch(/^1\s*\/\*\*/);
  await expect(pane.locator(".file-note")).toHaveCount(0);
  await expect(page.locator("#file-path")).toHaveText(/^\/.*\/client\/markdown\.ts$/);

  // ── the file he is reading is OPEN: ONE row, and it is the one on ──
  // A file is a member of the open set (SPEC 189), and since 196 the set holds one thing beside the
  // chat: opening the next file displaced the last rather than joining it. What replaced "every file
  // is still there" is the displaced slot — closing this one gives back the file before it, once.
  const fileRows = page.locator('.open-row[data-kind="file"]');
  await expect(fileRows, "one row, the file being read").toHaveCount(1);
  await expect(page.locator(".open-row.on"), "the file being read is the row on").toHaveClass(/on/);
  // Its head is INSIDE the scroller, so it scrolls with the file instead of sitting over it.
  const headInside = await page.locator("#file-head").evaluate((node) => ({
    inScroller: node.parentElement?.id === "file-body",
    first: node.parentElement?.firstElementChild === node,
  }));
  expect(headInside.inScroller, "the name and path scroll with the content").toBe(true);
  expect(headInside.first).toBe(true);
  // Closing the ROW closes the file — the same gesture as closing a record. What comes back is the
  // file this one displaced, so the count holds at one and the KEY changes (SPEC 196).
  const shownKey = await fileRows.getAttribute("data-key");
  await fileRows.locator(".open-close").click();
  await expect(fileRows).toHaveCount(1);
  await expect(fileRows, "the file it displaced came back").not.toHaveAttribute("data-key", shownKey ?? "");

  // ── 7 · an external link leaves loom ALONE ───────────────────────
  // Back to the transcript first: the file was up, and a file owns the whole centre now.
  await page.locator('.open-row[data-kind="session"]').click();
  await expect(page.locator("#chat-area")).toBeVisible();
  const ext = page.locator(".msg", { hasText: "Two records:" }).last().locator("a.ext").first();
  await expect(ext).toHaveAttribute("target", "_blank");
  await expect(ext).toHaveAttribute("rel", /noopener/);
  // It is deliberately not a chip: a chip would be a promise loom cannot keep for a URL.
  await expect(ext).not.toHaveClass(/chip/);
  const before = page.url();
  await ext.click({ modifiers: [] }).catch(() => {});
  await expect(page.locator("#status")).toContainText("live");
  expect(page.url()).toBe(before); // the loom tab is still the loom tab

  expect(errors).toEqual([]);
});
