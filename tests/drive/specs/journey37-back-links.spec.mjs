/**
 * Following a LINK, and pressing Back after it, land on a real place — SPEC 222.
 *
 * User, 2026-08-29, with a screenshot of a blank transcript and a composer under it: *"browser
 * going back when moving between links in loom is still not working"*. The third report of the
 * same symptom.
 *
 * `journey30-back` already drives the history STACK — one entry per gesture, restored in place
 * rather than reloaded — and it drives it through TREE ROWS. This file drives the other half: what
 * a restored address SHOWS, through the gestures he actually makes inside a session. Both go
 * through `applyLocation`; only the link path goes through `restoreOpens`, which selects the chat
 * because that is where a deep link has always landed, and for a project whose store holds no
 * session that selection is a composer over nothing.
 *
 * Driven against the pre-fix client the first case reads
 * `{"chatUp":true,"placeholder":true,"recordText":240}` — the record page had its work items ready
 * and the empty chat was put on screen over it.
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

const sentinel = (page) => page.evaluate(() => window.__backSentinel ?? null);

/** What the centre is actually showing — the transcript with turns, or the record with its text. */
const centre = (page) =>
  page.evaluate(() => {
    const chat = document.querySelector("#chat-area");
    const record = document.querySelector("#record-body");
    const transcript = document.querySelector("#transcript-body");
    return {
      chatUp: chat !== null && !chat.hidden && chat.offsetParent !== null,
      recordUp: record !== null && !record.hidden && record.offsetParent !== null,
      messages: transcript === null ? 0 : transcript.childElementCount,
      recordText: record === null ? 0 : (record.textContent ?? "").trim().length,
    };
  });

/** His complaint, as an assertion: some centre is up and it has something in it. */
async function expectUsable(page, what) {
  await expect
    .poll(async () => {
      const seen = await centre(page);
      const up = seen.chatUp || seen.recordUp;
      const full = seen.chatUp ? seen.messages > 0 : seen.recordText > 0;
      return up && full ? "usable" : JSON.stringify(seen);
    }, { timeout: 15_000, message: `${what} must not be a composer over nothing` })
    .toBe("usable");
}

const kindChips = (page) => page.locator(".msg", { hasText: "Two records:" }).last().locator(".chip");

const currentRow = (page) =>
  page.evaluate(() => document.querySelector(".tree-item.current")?.getAttribute("data-record") ?? null);

async function enterFixtureParent(page) {
  const rows = page.locator(".tree-item[data-record]");
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    const path = await rows.nth(i).getAttribute("data-record");
    if ((path ?? "").endsWith("loom-fixture-parent/project.md")) {
      await rows.nth(i).click();
      return path;
    }
  }
  throw new Error("the fixture tree has no loom-fixture-parent row");
}

test("a loom link into a project with no session lands on its record, and Back comes home", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__backSentinel = "alive";
  });

  const parent = await enterFixtureParent(page);
  await expect(kindChips(page).first()).toBeVisible({ timeout: 20_000 });
  await expectUsable(page, "the project we start in");

  // ── the link he clicks ─────────────────────────────────────────────
  //
  // `loom-fixture-child` has a record and NO session store, which is the ordinary state of a
  // project he has not talked to yet — and the state that produced his screenshot.
  const inward = page.locator(".msg", { hasText: "Two records:" }).last().locator("a[data-loom]").first();
  await inward.click();
  await expect.poll(() => currentRow(page), { timeout: 15_000 }).toContain("loom-fixture-child");
  await expectUsable(page, "the project the link named");

  // Specifically the RECORD page: there is no session here, so the chat has nothing to show.
  const landed = await centre(page);
  expect(landed.recordUp && !landed.chatUp, `the record is the centre, not an empty chat: ${JSON.stringify(landed)}`).toBe(true);
  expect(await sentinel(page), "the link walked in place rather than booting a second loom").toBe("alive");

  // ── Back ───────────────────────────────────────────────────────────
  await page.goBack();
  await expect.poll(() => currentRow(page), { timeout: 15_000 }).toBe(parent);
  await expectUsable(page, "the place Back returned to");
  expect(await sentinel(page), "Back restored in place rather than reloading").toBe("alive");

  // ── Forward runs the same restore path, and has the same defect ────
  await page.goForward();
  await expect.poll(() => currentRow(page), { timeout: 15_000 }).toContain("loom-fixture-child");
  await expectUsable(page, "the place Forward returned to");
  expect(await sentinel(page), "Forward restored in place too").toBe("alive");

  expect(errors).toEqual([]);
});

test("an address naming a session this store does not hold opens a real one instead", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const parent = await enterFixtureParent(page);
  await expect(kindChips(page).first()).toBeVisible({ timeout: 20_000 });

  // The shape `enterRecord` can leave in history when its session load is abandoned: the right
  // record, paired with a session id this store has never held.
  await page.goto(`/?record=${encodeURIComponent(parent)}&session=00000000-0000-0000-0000-00000000dead`);
  await expect(page.locator("#status")).not.toContainText("connecting", { timeout: 20_000 });
  await expectUsable(page, "an address naming a session that is not here");

  expect(errors).toEqual([]);
});
