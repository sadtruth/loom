/**
 * Work items in the right column, driven end to end (SPEC 75–78).
 *
 * The need is not "tasks appear somewhere else" — it is that a task can be ticked WITHOUT LEAVING
 * THE CONVERSATION it is being ticked for. So the whole flow runs with the session on screen and
 * asserts `#record-body` stayed hidden throughout: the moment ticking costs you the transcript the
 * feature has failed, however well the rows rendered.
 *
 * The spec drives the ONE fixture item journey5 never touches (the boxless prose row), so it makes
 * its own finished task rather than inheriting one, and its counts are relative to what it found.
 * Order-independence matters here: this runs last, and a pin that only passes in one order is a pin
 * that will one day pass for the wrong reason.
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
const FINISHED = /is-(done|dropped|promoted)/;

const classesOf = (rows) => rows.evaluateAll((els) => els.map((e) => e.className));

test("the right column carries the work items, tickable without leaving the session", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // ── no project entered, so there is nothing whose items these would be ──
  await expect(page.locator("#drawer-tasks")).toBeDisabled();
  await expect(page.locator("#drawer-files")).toHaveClass(/on/);

  // ── entering a project lands on its session, and the items come WITH it ──
  await page.locator(".tree-item", { hasText: parent() }).first().click();
  const chat = page.locator("#chat-area");
  const record = page.locator("#record-body");
  await expect(chat, "the transcript is what he is looking at").toBeVisible();
  await expect(record).toBeHidden();
  await expect(page.locator("#drawer-tasks")).toBeEnabled();
  await expect(page.locator("#drawer-tasks")).toHaveClass(/on/);

  const rows = page.locator("#drawer-body .task");
  await expect(rows.first()).toBeVisible();
  const live = await rows.count();
  // The badge counts what is LEFT, not what exists: a column reporting 10 when 8 are finished is
  // reporting nothing.
  await expect(page.locator("#drawer-count")).toHaveText(String(live));
  expect(
    (await classesOf(rows)).some((c) => FINISHED.test(c)),
    "nothing finished is showing at rest",
  ).toBe(false);

  // ── a prose row is offered a box, and taking it writes the record ────
  const prose = rows.filter({ hasText: "A plain prose item" }).first();
  await expect(prose).toHaveClass(/prose/);
  await prose.locator(".task-addbox").click();
  await expect(prose).toHaveClass(/is-open/);
  await prose.locator(".task-box").click();
  await expect(prose).toHaveClass(/is-doing/);
  await expect(record, "two writes in, still in the conversation").toBeHidden();

  // ── the verdict gate holds at 300px: done still demands a result ─────
  await prose.locator(".task-box").click(); // doing → the form, NOT done
  const form = prose.locator(".task-form");
  await expect(form).toBeVisible();
  await form.locator(".task-save").click();
  await expect(prose).not.toHaveClass(/is-done/);
  await expect(form.locator(".task-form-text")).toHaveClass(/bad/);
  // The artifacts on offer are this session's real touches — the form is not a stub in here.
  const candidate = form.locator(".task-cand").first();
  await expect(candidate).toBeVisible();
  await candidate.click();
  await form.locator(".task-form-text").fill("ticked from the right column, session never left");
  await form.locator(".task-save").click();
  await expect(prose).toHaveCount(0); // it finished, so it left the live list
  await expect(record, "and neither did writing the result").toBeHidden();
  await expect(chat).toBeVisible();

  // ── what finished folds away, and comes back on one click ────────────
  await expect(rows).toHaveCount(live - 1);
  await expect(page.locator("#drawer-count")).toHaveText(String(live - 1));
  const fold = page.locator(".drawer-more");
  await expect(fold).toContainText("finished");
  const folded = Number((await fold.textContent())?.match(/\d+/)?.[0] ?? "0");
  expect(folded, "the item just finished is in the fold").toBeGreaterThan(0);
  await fold.click();
  await expect(rows).toHaveCount(live - 1 + folded);
  expect(
    (await classesOf(rows)).some((c) => FINISHED.test(c)),
    "expanding the fold really does show finished items",
  ).toBe(true);
  await fold.click();
  await expect(rows).toHaveCount(live - 1);

  // ── the two hosts are ONE record: the centre must say what the column said ──
  await page.locator('.open-row[data-kind="record"]').first().click();
  const inTab = record.locator(".task").filter({ hasText: "A plain prose item" }).first();
  await expect(inTab).toHaveClass(/is-done/);
  await expect(inTab).toContainText("ticked from the right column, session never left");
  await expect(inTab.locator(".task-arts .chip")).toHaveCount(1);

  // ── with the record up in the centre, the column hands the space back to the files ──
  await expect(page.locator("#drawer-files")).toHaveClass(/on/);
  await expect(page.locator("#drawer-body .art").first()).toBeVisible();

  // ── an explicit pick overrides the default and survives a reload ─────
  await page.locator("#drawer-tasks").click();
  await expect(page.locator("#drawer-body .task").first()).toBeVisible();
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator("#drawer-tasks")).toHaveClass(/on/);
  // Clicking the surface already shown releases the pick back to following the centre — the same
  // "collapsing must never be a one-way door" rule the drawer already lives by. Released under the
  // RECORD, so what the default does next is unambiguous.
  await page.locator('.open-row[data-kind="record"]').first().click();
  await expect(page.locator("#drawer-tasks"), "the pick still overrides the centre").toHaveClass(/on/);
  await page.locator("#drawer-tasks").click();
  await expect(page.locator("#drawer-files")).toHaveClass(/on/);

  expect(errors, "no page errors across the drawer-task flow").toEqual([]);
});
