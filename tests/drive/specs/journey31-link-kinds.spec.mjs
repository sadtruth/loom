/**
 * The link kinds this build fixed, each clicked in a browser — SPEC 226.
 *
 * User, 2026-08-19: *"opening many links in session still doesnt work, even after so many attempts
 * to solve it. Make a list of all possible links that could be put in the chat and write out a
 * solution for each."* The list is `navigating-links/link-kinds-2026-08-19.md`; this drives the
 * eight kinds it found broken. `journey19-links` already drives the seven that worked, and is left
 * alone rather than forked.
 *
 * Every case here CLICKS. The previous link build shipped with its pins passing and the kinds still
 * broken, and what caught that was User clicking a list — so a chip's attributes are never the
 * whole assertion, only the half that says which chip was found.
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

const kindChips = (page) => page.locator(".msg", { hasText: "Two records:" }).last().locator(".chip");

/**
 * Back to the transcript. A file and a record each own the WHOLE centre (SPEC 189), so every chip in
 * the message is hidden while one of them is up — including the ones this spec is about to read.
 */
async function backToChat(page) {
  await page.locator('.open-row[data-kind="session"]').click();
  await expect(page.locator("#chat-area")).toBeVisible();
  await expect(kindChips(page).first()).toBeVisible({ timeout: 20_000 });
}

async function clickChip(page, chip) {
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
}

test("every link kind the enumeration found broken now opens, or refuses with a way out", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();
  await expect(kindChips(page).first()).toBeVisible({ timeout: 20_000 });
  const pane = page.locator("#file-body");

  // ── 17 · a WORK ITEM is the record, at a row ──────────────────────
  //
  // The one that bit daily: `CLAUDE.md` rule 45 mandates this exact form for every task link, and
  // the place suffix could not carry the space in `#next 1`, so the chip never carried the place and
  // the click entered the project and landed nowhere in particular.
  const item = kindChips(page).filter({ hasText: /· item 1$/ }).first();
  await expect(item, "a work item reads as the project and the row, not as project.md").toBeVisible();
  await expect(item).toHaveClass(/rec/);
  await expect(item).toHaveAttribute("data-place", "#next 1");
  await expect(item).toHaveAttribute("data-path", /project\.md$/);
  await clickChip(page, item);
  // It enters the record AND opens the RECORD tab on the row named.
  //
  // The record centre is itself the proof the task branch ran: this project has a live session, so
  // entering it any other way lands on the session (SPEC 113). Deliberately not asserted on the
  // flash class — that is removed after 1.6s, and a pin must not own a clock (VERIFY).
  await expect(page.locator("#record-body")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#record-body .task[data-task="1"]')).toBeVisible({ timeout: 10_000 });

  await backToChat(page);
  // ── 7 · a line RANGE lands on its first line and marks the span ───
  const range = kindChips(page).filter({ hasText: "lines.txt:2-4" }).first();
  await expect(range, "the range survives into the chip's label").toBeVisible();
  await expect(range).toHaveAttribute("data-place", ":2-4");
  await expect(range).toHaveAttribute("data-path", /lines\.txt$/);
  await clickChip(page, range);
  const marked = pane.locator(".file-row.file-line");
  await expect(marked.first()).toBeVisible({ timeout: 10_000 });
  // Three lines, not one: marking only the first is indistinguishable from having dropped the range.
  await expect(marked, "the whole span is marked").toHaveCount(3);
  await expect(marked.first()).toHaveAttribute("data-line", "2");
  await expect(marked.nth(2)).toHaveAttribute("data-line", "4");

  // ── 6 · the place SURVIVES A RELOAD ───────────────────────────────
  //
  // It used to ride glued to the filename, so a restored URL asked the server for a file whose name
  // ended in a line number: a 400, every time, on every place link he sent himself.
  expect(page.url(), "the address carries the place on its own").toContain("place=");
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  const afterReload = pane.locator(".file-row.file-line");
  await expect(afterReload.first(), "the file came back at the same place").toBeVisible({ timeout: 20_000 });
  await expect(afterReload).toHaveCount(3);
  await expect(pane.locator(".file-refusal")).toHaveCount(0);

  await backToChat(page);

  // ── 5 · a RELATIVE DIRECTORY is a chip, and it lists ──────────────
  const relDir = kindChips(page).filter({ hasText: /^client\/$/ }).first();
  await expect(relDir, "a trailing slash is what declares a relative directory").toBeVisible();
  await expect(relDir).toHaveClass(/dir/);
  await clickChip(page, relDir);
  await expect(pane.locator(".file-dir"), "it resolved by climbing to the ancestor that holds it").toBeVisible({
    timeout: 10_000,
  });
  await expect(pane.locator(".file-dir-row .chip", { hasText: "markdown.ts" })).toBeVisible();

  await backToChat(page);

  // ── 11 · a WIKILINK resolves by name across the vault ─────────────
  const wiki = kindChips(page).filter({ hasText: /^ARCHITECTURE$/ }).first();
  await expect(wiki, "the vault's own link form renders as a chip").toBeVisible();
  await expect(wiki).toHaveClass(/wiki/);
  await expect(wiki).toHaveAttribute("data-path", "wiki:ARCHITECTURE");
  await clickChip(page, wiki);
  await expect(pane.locator(".file-md"), "the note itself, found by name").toContainText("loom", { timeout: 10_000 });
  // The header says the real file: a name was resolved to a path, not merely echoed back.
  await expect(page.locator("#file-path")).toHaveText(/ARCHITECTURE\.md$/);

  await backToChat(page);

  // ── 20 · a file:// URL is kind 1 wearing a scheme ─────────────────
  const fileUrl = kindChips(page).filter({ hasText: "the fixture lines" }).first();
  await expect(fileUrl, "a file URL is a chip, not an anchor the browser will refuse").toBeVisible();
  await expect(fileUrl).toHaveAttribute("data-path", /lines\.txt$/);
  await clickChip(page, fileUrl);
  await expect(pane.locator(".file-text")).toContainText("third line", { timeout: 10_000 });

  await backToChat(page);
  // ── item 10 · a PROTOTYPE opens as a page, not as its own markup ───
  //
  // 24 links in the 2026-08-24 audit opened as highlighted HTML. User: *"i dont really need to see
  // the source of prototype … maybe even never"*, so there is no switch to assert — the page is the
  // whole behaviour, and the absence of a source listing is half the assertion.
  const proto = kindChips(page).filter({ hasText: "fixture-widget-2026-08-01.html" }).first();
  await expect(proto, "a prototype link is a chip like any other").toBeVisible();
  await clickChip(page, proto);
  await expect(pane.locator(".embed iframe"), "it runs in a frame").toBeVisible({ timeout: 10_000 });
  await expect(pane.locator(".file-text"), "and never as a listing of its markup").toHaveCount(0);
  await expect(pane.locator(".embed-open"), "the way out to a tab is under it").toBeVisible();

  await backToChat(page);
  // ── item 12 · a WRITTEN link keeps its place ───────────────────────
  //
  // `[label](path:3)` asked the server for a file called `lines.txt:3` and got a 400 — 147 links,
  // every one of them written in the form the constitution mandates. No test touched this pass.
  const written = kindChips(page).filter({ hasText: "the third line" }).first();
  await expect(written, "a written link is a chip carrying its place").toBeVisible();
  await expect(written).toHaveAttribute("data-place", ":3");
  await expect(written).toHaveAttribute("data-path", /lines\.txt$/);
  await clickChip(page, written);
  await expect(pane.locator(".file-row.file-line"), "and it lands on the line").toContainText("third line", {
    timeout: 10_000,
  });

  await backToChat(page);
  // ── the same, in GitHub's `#L3` spelling ───────────────────────────
  const github = kindChips(page).filter({ hasText: "lines.txt:3" }).nth(1);
  await expect(github, "`#L3` is a line, not a heading").toBeVisible();
  await expect(github).toHaveAttribute("data-place", ":3");

  await backToChat(page);
  // ── item 13 · a line inside a RECORD lands on the item ────────────
  //
  // A rendered document has no lines, so 44 links reported "no :7 in this file". User chose
  // landing on the block the line is inside over dropping the record to source.
  const inRecord = kindChips(page).filter({ hasText: "headings.md:7" }).first();
  await expect(inRecord, "a line in a record is a chip carrying its place").toBeVisible();
  await expect(inRecord).toHaveAttribute("data-place", ":7");
  await clickChip(page, inRecord);
  await expect(pane.locator(".file-md"), "the record stays rendered").toBeVisible({ timeout: 10_000 });
  await expect(pane.locator(".file-md .file-line"), "and the block holding that line is marked").toContainText(
    "The section a #out-of-scope chip lands on",
    { timeout: 10_000 },
  );
  await expect(pane.locator(".file-note"), "no refusal note about a missing line").toHaveCount(0);

  await backToChat(page);
  // ── 12 · a refusal NAMES A WAY OUT ────────────────────────────────
  //
  // The path changed with item 15: the roots are the machine now, so what still refuses is a DENIED
  // name rather than an unlisted directory.
  const outside = kindChips(page).filter({ hasText: "id_ed25519" }).first();
  await expect(outside).toBeVisible();
  await clickChip(page, outside);
  const refusal = pane.locator(".file-refusal");
  await expect(refusal, "the refusal is a note the reader can act on").toBeVisible({ timeout: 10_000 });
  await expect(refusal).toContainText("403");
  await expect(refusal.locator(".file-roots"), "it names what was checked").toContainText("loom");
  await expect(refusal.locator(".file-handoff"), "and offers the one way that reaches outside").toBeVisible();
  await expect(refusal.locator(".file-handoff"), "naming the machine it would run on").toContainText(/open it on \S+/);

  await backToChat(page);

  // ── 246 · a chip naming the record he is ALREADY IN opens its page ─
  //
  // Every record chip went to `enterRecord`, and entering the record you are already inside decides
  // the centre from the rail's activity — the chat, which is what the click was made from. User,
  // 2026-08-25: *"the link to the project file in this session doesnt work now"*. Asserting the chat
  // is up BEFORE the click is half the check: a record page left open by an earlier case would
  // otherwise pass this without the click having done anything.
  const here = kindChips(page).filter({ hasText: /^Fixture parent project$/ }).first();
  await expect(here, "the chip names the project he is standing in").toBeVisible();
  await expect(here).toHaveClass(/rec/);
  await expect(page.locator("#chat-area"), "the chat is the centre the click is made from").toBeVisible();
  await expect(page.locator("#record-body")).toBeHidden();
  await clickChip(page, here);
  await expect(page.locator("#record-body"), "and the click opens the project's own page").toBeVisible({
    timeout: 10_000,
  });

  await backToChat(page);

  // ── 9 · a link to LOOM walks in place ─────────────────────────────
  //
  // It used to be caught as an external link and open a second loom in a new tab, booting from
  // scratch. The sentinel is what proves it walked rather than reloaded.
  await page.evaluate(() => {
    window.__loomSentinel = "alive";
  });
  const inward = page.locator(".msg", { hasText: "Two records:" }).last().locator("a[data-loom]").first();
  await expect(inward, "loom's own address is not an external link").toBeVisible();
  await expect(inward).not.toHaveClass(/ext/);
  await expect(inward).not.toHaveAttribute("target", "_blank");
  const pagesBefore = page.context().pages().length;
  await inward.click();
  await expect(page.locator(".tree-item.current"), "it walked to the project the link named").toContainText(
    /Fixture child project/,
    { timeout: 10_000 },
  );
  expect(await page.evaluate(() => window.__loomSentinel ?? null), "walked in place, never reloaded").toBe("alive");
  expect(page.context().pages().length, "and never opened a second loom").toBe(pagesBefore);

  expect(errors).toEqual([]);
});
