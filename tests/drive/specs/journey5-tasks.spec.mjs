/**
 * Tasks in a record, driven end to end (SPEC §Tasks): a work item is a very small project, so the
 * box has to actually move, `done` has to demand a result, the result has to carry the files it
 * came from, and a task that outgrew its line has to become a project you land inside.
 *
 * A narrow assertion would not catch what matters here — every step WRITES a real markdown file and
 * re-reads it, so the failure mode is a record that drifts from the screen. The spec therefore
 * re-enters the record after the writes and asserts the file, not the DOM state it left behind.
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

const parent = () => "Fixture parent project";

/** A record's row in the open list (SPEC 202) — what `.tab-record` used to name in the centre. */
const recordRow = (page, title) => page.locator('.open-row[data-kind="record"]', { hasText: title });

test("tasks: tick, finish with a result and its artifacts, split one out into a live subproject", async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: parent() }).first().click();
  // Entering a project with a live session now lands on the session (2026-08-06); the record — and
  // so its task list — is its row in the open list.
  await recordRow(page, parent()).click();

  // ── the claims render as rows, with the standing at the front ───────
  // The section sits BEFORE `## Next` in the file, so this also proves the split did not eat the
  // prose between them: "Where it stands" has to still be on screen, above the tasks.
  const hypos = page.locator(".hypo");
  await expect(hypos).toHaveCount(3);
  await expect(hypos.nth(0).locator(".hypo-standing")).toHaveText("open");
  await expect(hypos.nth(0)).toContainText("A claim still being tested.");
  await expect(hypos.nth(1)).toHaveClass(/is-refuted/);
  await expect(hypos.nth(1).locator(".hypo-standing")).toHaveText("refuted");
  await expect(hypos.nth(1).locator(".hypo-standing")).toHaveAttribute("title", /2026-08-05/);
  // No standing is not a guess at one.
  await expect(hypos.nth(2)).toHaveClass(/is-unstated/);
  await expect(hypos.nth(2).locator(".hypo-standing")).toHaveText("no standing");
  await expect(page.locator(".record-md")).toContainText("The child below reports back here.");

  // ── the items render as tasks, not as prose that looks like a list ──
  const tasks = page.locator(".task");
  await expect(tasks).toHaveCount(4);
  await expect(tasks.nth(0).locator(".task-box")).toBeVisible();
  await expect(tasks.nth(0)).toContainText("Tick me to doing");
  await expect(tasks.nth(0)).toContainText("the box has to resemble the status");
  // A boxless item is prose: loom offers a box rather than inventing a status for it.
  await expect(tasks.nth(3).locator(".task-box")).toHaveCount(0);
  await expect(tasks.nth(3).locator(".task-addbox")).toBeVisible();

  // ── one click moves the box, and the record on disk with it ─────────
  await tasks.nth(0).locator(".task-box").click();
  await expect(tasks.nth(0)).toHaveClass(/is-doing/);
  await expect(tasks.nth(0).locator(".task-box")).toHaveText("/");

  // ── done is a gate: the box does not move until a result is written ─
  await tasks.nth(1).locator(".task-box").click(); // open → doing
  await expect(tasks.nth(1)).toHaveClass(/is-doing/);
  await tasks.nth(1).locator(".task-box").click(); // doing → the form, NOT done
  const form = tasks.nth(1).locator(".task-form");
  await expect(form).toBeVisible();
  await expect(tasks.nth(1)).not.toHaveClass(/is-done/);

  // An empty result is refused — that is the whole point of the gate.
  await form.locator(".task-save").click();
  await expect(tasks.nth(1)).not.toHaveClass(/is-done/);
  await expect(form.locator(".task-form-text")).toHaveClass(/bad/);

  // The artifacts on offer are the files this project's session actually touched.
  const candidate = form.locator(".task-cand").first();
  await expect(candidate).toBeVisible();
  const artifactName = (await candidate.textContent())?.trim();
  await candidate.click();
  await expect(candidate).toHaveClass(/on/);
  await form.locator(".task-form-text").fill("the box moves and the record says so");
  await form.locator(".task-save").click();

  await expect(tasks.nth(1)).toHaveClass(/is-done/);
  await expect(tasks.nth(1)).toContainText("the box moves and the record says so");
  await expect(tasks.nth(1).locator(".task-arts .chip")).toHaveCount(1);

  // ── the result's artifact is a real file: it opens in loom's own pane ─
  await tasks.nth(1).locator(".task-arts .chip").first().click();
  await expect(page.locator("#file")).toBeVisible();
  await expect(page.locator("#file-title")).toContainText(artifactName ?? "");
  // A file is content, so it takes the whole centre (SPEC 200): the record stands down behind it
  // and comes back when the pane closes. It used to sit in a column of its own beside the record.
  await expect(page.locator("#record-body")).toBeHidden();
  await page.locator("#file-close").click();
  await expect(page.locator("#record-body")).toBeVisible();

  // ── the writes are in the FILE, not just on screen ──────────────────
  await page.locator(".tree-item.general").click();
  await page.locator(".tree-item", { hasText: parent() }).first().click();
  await recordRow(page, parent()).click(); // re-entering lands on the session now (2026-08-06)
  await expect(page.locator(".task").nth(0)).toHaveClass(/is-doing/);
  await expect(page.locator(".task").nth(1)).toHaveClass(/is-done/);
  await expect(page.locator(".task").nth(1)).toContainText("the box moves and the record says so");

  // ── authoring by hand: add one, retitle one, restate a standing ─────
  // Every one of these CREATES or REWRITES a line rather than ticking an existing one, so the
  // re-entry below is the assertion that matters: the file has to agree with the screen.
  await page.locator(".task-add .task-act").click();
  await page.locator(".task-add-text").fill("Added by hand — from the record tab");
  await page.locator(".task-add .task-save").click();
  await expect(page.locator(".task")).toHaveCount(5);
  await expect(page.locator(".task").nth(4)).toContainText("Added by hand");
  await expect(page.locator(".task").nth(4)).toHaveClass(/is-open/);

  // Retitling: the name only. The result and artifacts written above must still be underneath it.
  await page.locator(".task").nth(1).locator(".task-title").click();
  const rename = page.locator(".task").nth(1).locator(".task-title-edit");
  await expect(rename).toBeVisible();
  await rename.fill("Finished, and renamed after the fact");
  await rename.press("Enter");
  await expect(page.locator(".task").nth(1)).toContainText("Finished, and renamed after the fact");
  await expect(page.locator(".task").nth(1)).toContainText("the box moves and the record says so");
  await expect(page.locator(".task").nth(1).locator(".task-arts .chip")).toHaveCount(1);

  // The standing is a menu of the linter's six words; picking one stamps today's date.
  await hypos.nth(0).locator(".hypo-standing").click();
  await hypos.nth(0).locator(".hypo-pick", { hasText: "refuted" }).click();
  await expect(hypos.nth(0)).toHaveClass(/is-refuted/);
  await expect(hypos.nth(0).locator(".hypo-standing")).toHaveAttribute("title", /since \d{4}-\d{2}-\d{2}/);
  // The claim's own words and its evidence are untouched — only the standing moved.
  await expect(hypos.nth(0)).toContainText("A claim still being tested.");
  await expect(hypos.nth(0)).toContainText("nothing has come back yet");

  // ── all three are in the FILE too ───────────────────────────────────
  await page.locator(".tree-item.general").click();
  await page.locator(".tree-item", { hasText: parent() }).first().click();
  await recordRow(page, parent()).click();
  await expect(page.locator(".task")).toHaveCount(5);
  await expect(page.locator(".task").nth(4)).toContainText("Added by hand");
  await expect(page.locator(".task").nth(1)).toContainText("Finished, and renamed after the fact");
  await expect(page.locator(".task").nth(1)).toContainText("the box moves and the record says so");
  await expect(page.locator(".hypo").nth(0)).toHaveClass(/is-refuted/);
  // The claim that never had a standing still does not have one — loom gave it nothing.
  await expect(page.locator(".hypo").nth(2)).toHaveClass(/is-unstated/);

  // ── split a task out: a child record, entered, with a live session ──
  await page.locator(".task").nth(2).locator(".task-act", { hasText: "subproject" }).click();
  await expect(page.locator(".tree-item", { hasText: "Split me out" })).toBeVisible({ timeout: 20_000 });
  // Inside the child: its row is in the open list and the tree says it is where he now is. The old
  // assertion read the FIRST tab, which was the record tab whether or not it was the one on screen.
  await expect(recordRow(page, "Split me out"), "the child is open").toHaveCount(1);
  await expect(page.locator(".tree-item.current"), "the centre is inside the child").toContainText("Split me out");
  // The seed is a DRAFT: it sits in the composer with the cursor after "What I meant by it:", and
  // nothing has been sent — the split is the moment User knows more than the task's line held.
  const composer = page.locator("#composer-text");
  await expect(composer).toHaveValue(/just split out of/);
  await expect(composer).toHaveValue(/What I meant by it:/);
  // And it is a draft OF THIS SESSION (scenario 6): walking to the parent's session gives him the
  // parent's own empty box, and walking back gives the seed again. Before drafts were per session
  // the seed would have followed him into the parent and sat there ready to send in the wrong place.
  await page.locator(".tree-item", { hasText: parent() }).first().click();
  await expect(composer, "the parent's box is the parent's").toHaveValue("");
  await page.locator(".tree-item", { hasText: "Split me out" }).first().click();
  await expect(composer, "the seed waited in the session it was written for").toHaveValue(
    /What I meant by it:/,
  );
  // The DRAFT comes back; the "composing a new session" flag does not, because `enterRecord` clears
  // it. Pre-existing and outside this build, so the spec puts the child back into composition the
  // way he would — clicking `#add-claude`, which finds the seed already in the box.
  await page.locator("#add-claude").click();
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  await expect(composer, "the seed is still there after starting the composition again").toHaveValue(
    /What I meant by it:/,
  );
  await expect(page.locator("#transcript-body")).not.toContainText("stub reply:");
  // He adds it and sends; only then does a real session exist and answer through the READ path.
  await composer.pressSequentially("it needs its own session because the parent's is full of other things");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub reply:", { timeout: 30_000 });
  await expect(page.locator("#transcript-body")).toContainText("just split out of");
  await expect(page.locator("#transcript-body")).toContainText("full of other things");
  // The session is adopted (it is in the picker) before the spec navigates on, so what follows is
  // testing navigation rather than racing the adopt poll.
  await expect(page.locator("#select-claude option")).toHaveCount(1); // the session
  await expect(page.locator("#row-claude")).toHaveClass(/active/);

  // The child's own record carries the frame stub and its first work item.
  await recordRow(page, "Split me out").click();
  await expect(page.locator("#record-body h2", { hasText: "Frame" })).toBeVisible();
  await expect(page.locator("#record-body")).toContainText("Boundary. Not written yet");
  await expect(page.locator("#record-body")).toContainText("a task that outgrew its line becomes a project");
  await expect(page.locator(".task")).toHaveCount(1);
  await expect(page.locator(".task").first()).toContainText("Write the frame with User");

  // ── back up: the parent's item now points at the child, both ways ───
  await page.locator(".record-up").click();
  await recordRow(page, parent()).click(); // the parent has a session, so walking up lands there
  await expect(page.locator("#record-body")).toContainText("The child below reports back here");
  const promoted = page.locator(".task").nth(2);
  await expect(promoted).toHaveClass(/is-promoted/);
  await expect(promoted.locator(".task-box")).toHaveText("↳");
  await promoted.locator(".task-act", { hasText: "open subproject" }).click();
  // The child has a live session by now, so its door lands on that session; the record is one row
  // over in the open list and still says whose it is.
  await expect(page.locator(".open-row.on")).toHaveAttribute("data-kind", "session");
  await expect(recordRow(page, "Split me out")).toHaveCount(1);

  expect(errors, "no page errors across the task flow").toEqual([]);
});
