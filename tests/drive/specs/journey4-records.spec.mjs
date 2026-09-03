/**
 * The project workspace, driven (SPEC §Records + workspace v1): entering a project switches the
 * WHOLE context — its sessions on the left, its record in the centre, its address in the URL —
 * and general is the way back. Plus the drawer's reopen handle: collapsing is never one-way.
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

test("workspace: enter a project, its sessions and record and URL; general is the way back", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // ── the tree: general first, then the family, child nested ──────
  const items = page.locator(".tree-item");
  // Six since 2026-08-13: the restore spec (SPEC 180) needs a record of its own, because it
  // ships a written ledger and a two-car train that no other spec may see.
  await expect(items).toHaveCount(6);
  await expect(items.nth(0)).toContainText("general");
  await expect(items.nth(1)).toContainText("Fixture parent project");
  // Two children under it — the second one carries the train (journey9). Located by NAME rather
  // than index: sibling order follows record mtime, which is not this spec's business.
  const child = page.locator(".tree-item", { hasText: "Fixture child project" });
  await expect(child).toHaveCount(1);
  await expect(page.locator(".tree-item", { hasText: "Fixture train project" })).toHaveCount(1);

  // ── enter the child: full context switch ────────────────────────
  await child.click();
  await expect(page.locator("#record-body")).toContainText("Split out to prove the parent edge");
  // The open list, not the tab strip: the chat row and the record he just opened (SPEC 202).
  await expect(page.locator(".open-row")).toHaveCount(2);
  await expect(page.locator(".open-row.on")).toContainText("Fixture child project");
  // Its sessions, not the general pool — none exist yet, so the picker is already composing the
  // first one rather than offering an empty list to stare at.
  await expect(page.locator("#select-claude option:checked")).toHaveText("new session — type to begin");
  await expect(page.locator("#status")).toContainText("no sessions here yet");
  // He can talk to the project while reading its record — 2026-08-06, "reading the record and
  // talking to the project are one activity", and User's ruling on 2026-08-12 when SPEC 199 put
  // the composer inside the chat's scroller and briefly took it away: "no loss".
  const composer = page.locator("#composer");
  const box = page.locator("#composer-text");
  await expect(composer, "the composer is on screen under a record").toBeVisible();
  // ONE composer, not two: the same element, moved. Under a record it hangs off the centre column;
  // in the chat it is the last thing in the scroller. Two boxes would be two drafts to lose.
  await expect(composer).toHaveCount(1);
  await expect(composer, "under a record it is a child of the centre column").toHaveJSProperty(
    "parentElement.id",
    "transcript",
  );
  // And it is the same DRAFT: what he types under the record is waiting in the chat, and vice versa.
  await box.fill("typed while reading the record");
  await page.locator('.open-row[data-kind="session"]').click();
  await expect(composer).toBeVisible();
  await expect(composer, "in the chat it is back inside the scroller").toHaveJSProperty(
    "parentElement.id",
    "transcript-body",
  );
  await expect(box, "the draft crossed with him, because there is only one of it").toHaveValue(
    "typed while reading the record",
  );
  await page.locator('.open-row[data-kind="record"]').click();
  await expect(box, "and back again").toHaveValue("typed while reading the record");
  // It never docks here: docking says "your place in the flow scrolled away", and under a record it
  // has no place in a flow (SPEC 199, 182).
  await expect(composer).not.toHaveClass(/docked/);
  await expect(page.locator("#write-pill")).toBeHidden();
  // Usable, not merely present: a message typed under the record is sent to the project's session,
  // and the box he sent it from empties. The answer lands in the chat, one row away.
  await box.fill("asked while reading the record");
  await box.press("Enter");
  await expect(box, "the box empties on send, under a record like anywhere else").toHaveValue("");
  await page.locator('.open-row[data-kind="session"]').click();
  await expect(page.locator("#transcript-body")).toContainText("asked while reading the record", {
    timeout: 30_000,
  });
  await expect(page.locator("#transcript-body")).toContainText("stub reply:", { timeout: 30_000 });
  await page.locator('.open-row[data-kind="record"]').click();
  // The URL carries the context.
  expect(page.url()).toContain("record=");
  expect(decodeURIComponent(page.url())).toContain("loom-fixture-child");

  // ── the parent link walks up, still in-context ──────────────────
  await page.locator(".record-up").click();
  // Entering a project with a LIVE session lands on the session, not the record (2026-08-06): the
  // parent has one, so the session tab is on and the record is one click away.
  //
  // The order of these two assertions is the requirement, not a detail. It used to read the parent's
  // markdown out of `#record-body` FIRST — which passed only because entering a project drew the
  // record centre in full before swapping to the session, i.e. because of the flash User asked us
  // to remove (221). With the flash gone the pane is empty until the tab is opened, so the walk-up
  // is checked by where it LANDS, and the parent's text by opening the record it entered.
  await expect(page.locator(".open-row.on")).toHaveAttribute("data-kind", "session");
  await page.locator('.open-row[data-kind="record"]', { hasText: "Fixture parent project" }).click();
  await expect(page.locator(".open-row.on")).toContainText("Fixture parent project");
  await expect(page.locator("#record-body")).toContainText("The child below reports back here");

  // ── general is the way back to the repo-wide pool ───────────────
  await page.locator(".tree-item.general").click();
  await expect(page.locator("#transcript-body")).toBeVisible();
  await expect(page.locator(".msg").first()).toBeVisible();
  // The list STAYS, and it holds ONE thing beside the chat (SPEC 196). It used to accumulate; the
  // list that grew was the noise User asked to remove — "just opening a project should not leave a
  // permanent mark like that" — so the second record he opened replaced the first rather than
  // joining it. The chat is the row on, because general is the repo-wide pool and has no record.
  await expect(page.locator("#opens")).toBeVisible();
  await expect(page.locator(".open-row")).toHaveCount(2);
  await expect(page.locator(".open-row.on")).toHaveAttribute("data-kind", "session");
  await expect(page.locator('.open-row[data-kind="record"]'), "one record, the last one entered").toHaveCount(1);
  await expect(page.locator('.open-row[data-kind="record"]')).toContainText("Fixture parent project");

  // ── opening displaces, and closing gives back what was displaced ─
  // Depth one, not a history (SPEC 196): reading a record, opening one of its files and coming back
  // is an ordinary move, and without this it would drop to the chat.
  const parentKey = await page.locator('.open-row[data-kind="record"]').getAttribute("data-key");
  await page.locator(".tree-item", { hasText: "Fixture child project" }).first().click();
  await expect(page.locator('.open-row[data-kind="record"]'), "still one row").toHaveCount(1);
  await expect(page.locator('.open-row[data-kind="record"]')).toContainText("Fixture child project");
  await page.locator('.open-row[data-kind="record"]').locator(".open-close").click();
  await expect(page.locator('.open-row[data-kind="record"]'), "the one it displaced came back").toHaveCount(1);
  await expect(page.locator('.open-row[data-kind="record"]')).toHaveAttribute("data-key", parentKey ?? "");

  // ── the set SURVIVES A RELOAD (SPEC 201, scenario 4) ────────────
  // `toParams`/`fromParams` were written and property-tested and nothing called them: the URL
  // carried one record and one session, so a file died on refresh. Driven here because the property
  // tests cannot see the wiring. Since 196 there is one member to carry, and it still has to survive.
  //
  // The chip is taken from the PARENT's own session, not from whatever is on screen in general.
  // `make-fixture` writes that message itself (the chip-kinds turn), while general's transcript is
  // the largest real transcript on the machine and carries a file path only by luck — this case
  // waited 45s for one and timed out in the suite while passing alone (2026-08-13).
  await page.locator('.open-row[data-kind="record"]', { hasText: "Fixture parent project" }).click();
  await page.locator('.open-row[data-kind="session"]').click();
  const chip = page.locator(".chip.file").first();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expect(page.locator("#file")).toBeVisible();
  await expect(page.locator('.open-row[data-kind="file"]')).toHaveCount(1);
  const fileKey = await page.locator('.open-row[data-kind="file"]').getAttribute("data-key");
  expect(page.url(), "the file rides in the URL").toContain("file=");
  // And no SECOND record rides with it. `record=` is still there once — it names the project he is
  // IN, which is workspace state and not a member of the set — but the set itself holds one thing,
  // so the two-record URL this case used to assert cannot happen any more (SPEC 196).
  expect(page.url(), "the set holds one thing, so no second record rides in the URL").not.toMatch(
    /record=.*record=/,
  );

  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator('.open-row[data-kind="file"]'), "the file came back").toHaveCount(1);
  // The same file, by the path it names — not merely "a file row".
  await expect(page.locator('.open-row[data-kind="file"]')).toHaveAttribute("data-key", fileKey);
  // A rebuilt set lands on the chat — the URL cannot carry which member was selected.
  await expect(page.locator(".open-row.on")).toHaveAttribute("data-kind", "session");
  // And the file is re-opened FROM ITS PATH: clicking its row reads it, with no record behind it.
  await page.locator('.open-row[data-kind="file"]').click();
  await expect(page.locator("#file")).toBeVisible();
  await expect(page.locator("#file-body")).not.toBeEmpty();

  // Rows close ONE AT A TIME, and the chat row has no close at all. Closing the file gives back what
  // it displaced — and after a reload that is the record of the project the URL put him back in, not
  // the chat: `boot()` enters that project, and entering is an open like any other (SPEC 196).
  await expect(page.locator('.open-row[data-kind="session"] .open-close')).toHaveCount(0);
  await page.locator('.open-row[data-kind="file"]').locator(".open-close").click();
  await expect(page.locator('.open-row[data-kind="file"]')).toHaveCount(0);
  await expect(page.locator(".open-row"), "the chat and the record that came back").toHaveCount(2);
  await expect(page.locator('.open-row[data-kind="record"]')).toHaveCount(1);
  await page.locator('.open-row[data-kind="session"]').click();
  await expect(page.locator(".open-row.on")).toHaveAttribute("data-kind", "session");
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  expect(await page.locator("#select-claude option").count()).toBeGreaterThan(0);

  // ── Escape closes the SELECTED non-chat member (SPEC 187) ───────
  // It used to shut the wheel first and the file pane second. The wheel is gone and a file is a row
  // in the open list like a record, so there is one rule for both — and the chat is not closable, so
  // Escape on the chat row does nothing rather than emptying the centre.
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await page.locator('.open-row[data-kind="record"]').click();
  await page.locator("#record-body").click(); // out of the composer: shortcuts never fire while typing
  await expect(page.locator(".open-row.on")).not.toHaveAttribute("data-kind", "session");
  await page.keyboard.press("Escape");
  await expect(page.locator(".open-row"), "the selected record closed").toHaveCount(1);
  await expect(page.locator(".open-row.on"), "and the centre landed on a neighbour").toHaveAttribute("data-kind", "session");
  await page.keyboard.press("Escape");
  await expect(page.locator(".open-row"), "the chat row cannot be closed").toHaveCount(1);

  // ── the drawer's collapse is reversible ─────────────────────────
  await page.locator("#drawer-collapse").click();
  await expect(page.locator("#drawer")).toBeHidden();
  await expect(page.locator("#drawer-reopen")).toBeVisible();
  await page.locator("#drawer-reopen").click();
  await expect(page.locator("#drawer")).toBeVisible();

  expect(errors, "no page errors across the workspace flow").toEqual([]);
});

/**
 * P10 — "where is a reply for me" (SPEC 62–64).
 *
 * The question the tree exists to answer once User works across many sessions. Driven the only
 * way that proves it: a reply is written into a project he is NOT looking at, and the mark has to
 * appear on its own; then he reads it, and the mark has to go.
 */
test("attention: a reply elsewhere draws a letter, reading it clears it, writing leaves a ring", async ({ page }) => {
  const errors = watchErrors(page);
  const { appendFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");

  const root = fileURLToPath(new URL("../../..", import.meta.url));
  // The config exports the slotted fixture root; the default keeps "no setup" true.
  const store = process.env["LOOM_FIXTURE_OUT"] ?? join(root, "tests/fixture/projects");
  // The parent record's store: its sessions are keyed by the record's DIRECTORY (SPEC 47).
  const dir = readdirSync(store).find((d) => d.includes("loom-fixture-parent"));
  expect(dir, "the parent record has a session store").toBeDefined();
  const file = join(store, dir, readdirSync(join(store, dir))[0]);

  // Named rather than "/": the whole case is about a reply arriving where the reader is NOT, and
  // "/" lands on whichever project is newest. make-fixture backdates the parent, so alone that is
  // the general pool and the case passes — but earlier specs on the same worker post live turns
  // into the parent's session 3, which makes IT the newest, so the full suite opened the very
  // session the reply lands in. Loom then marks each row read as it arrives over the socket and
  // the letter can never be drawn. Red in the suite, green alone, on every commit, until the start
  // location was pinned (proved 2026-09-01 by printing state.seen at the case's first line:
  // seen["…0003"] was already newer than the reply).
  await page.clock.install();
  await page.goto("/?project=-fixture-project&session=00000000-fixture-0000-000000000001");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  const parentRow = page.locator(".tree-item", { hasText: "Fixture parent project" });
  await expect(parentRow.locator(".tree-dot.unread"), "nothing unread before the reply").toHaveCount(0);

  // An INTERMEDIATE reply lands first — the turn is still going (SPEC 111). On its own this used to
  // ring the letter; now it must not, because nothing is waiting yet.
  appendFileSync(
    file,
    `${JSON.stringify({
      type: "assistant",
      // Its own id. It used to reuse one already in this session, which made these two appended
      // rows COPIES of rows already there rather than new ones — see the note in make-fixture.ts.
      uuid: "44444444-0000-0000-0000-000000000009",
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: "00000000-fixture-0000-000000000003",
      isSidechain: false,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working on it" }],
        stop_reason: "tool_use",
      },
    })}\n`,
  );
  // Force the poll now rather than waiting out the real 15 s interval — the same `visibilitychange`
  // path a tab returning to the foreground takes (client/app.ts).
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(500);
  await expect(parentRow.locator(".tree-dot.unread"), "an intermediate reply draws no mark").toHaveCount(0);

  // The reply that ENDS the turn lands next.
  appendFileSync(
    file,
    `${JSON.stringify({
      type: "assistant",
      uuid: "44444444-0000-0000-0000-000000000010",
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: "00000000-fixture-0000-000000000003",
      isSidechain: false,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "a reply nobody has read yet" }],
        stop_reason: "end_turn",
      },
    })}\n`,
  );

  // It announces itself — no click, no reload; the poll is the whole point.
  // One advance was enough solo and not under eight workers: with the clock frozen the poll cannot
  // re-fire on its own, so a first paint that lost the race never got a second one. Keep advancing.
  await expect
    .poll(
      async () => {
        await page.clock.runFor(15_000);
        return parentRow.locator(".tree-dot.unread").count();
      },
      { timeout: 40_000, message: "the letter appeared once the turn finished" },
    )
    .toBe(1);
  // A letter is DRAWN, not a repurposed circle: the envelope is real geometry.
  //
  // Polled with the SAME clock advance as the assertion above, not asserted bare. The clock is
  // frozen, so that loop is the only thing making time pass: if the paint that first carries
  // `.unread` does not also carry the letter, a bare wait can never see the paint that adds it and
  // sits at 0 for its whole timeout. That is exactly what it did — `13 × locator resolved to 0
  // elements` — going red on three runs of 2026-08-31 and green on the others, which reads as a
  // flake and is not one. The CLAIM is unchanged: if the letter is genuinely never drawn, this
  // still fails, now after 40s of advanced clock rather than 5s of frozen one.
  await expect
    .poll(
      async () => {
        await page.clock.runFor(15_000);
        return parentRow.locator(".tree-dot.unread svg").count();
      },
      { timeout: 40_000, message: "the unread mark is a drawn letter, not a bare circle" },
    )
    .toBe(1);
  // Entering now lands ON the session (2026-08-06), and landing there is what reads it — so the
  // unread mark is asserted from the tree, before entering, rather than from the picker after.
  await parentRow.click();

  // Reading it clears it — and the transcript really shows the reply, so "read" is not a lie.
  await page.locator('.open-row[data-kind="session"]').click();
  await expect(page.locator("#transcript-body")).toContainText("a reply nobody has read yet", { timeout: 20_000 });
  await expect(parentRow.locator(".tree-dot.unread"), "reading cleared the letter").toHaveCount(0, {
    timeout: 40_000,
  });
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  await expect(page.locator("#select-claude option:checked")).not.toContainText("✉");

  // The ring is the OTHER signal and outlives the letter: User typed here inside the window.
  await expect(parentRow.locator(".tree-dot.active"), "still marked as somewhere he was working").toHaveCount(1);

  expect(errors, "no page errors across the attention flow").toEqual([]);
});
