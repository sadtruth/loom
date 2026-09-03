/**
 * The transcript holds still while a session works (SPEC 211).
 *
 * User, 2026-08-14: *"While you're working in a session — writing something or thinking or
 * running commands — that session for me in loom is pretty unusable. It keeps flashing (the
 * embedded prototypes and build plans)."*
 *
 * The cause is that a redraw rebuilds every row, and an `iframe` block builds a NEW frame and a new
 * fetch each time. A frame cannot merely be cached and re-appended either: re-parenting an iframe
 * discards its browsing context, so the document reloads and its scripts run again from zero. So
 * the only thing that holds a prototype still is a redraw that does not TOUCH the row it sits in.
 *
 * Driven, and deliberately not dispatched: the redraws come from a real turn running underneath,
 * which is the reader's actual situation.
 */

import { expect, test } from "@playwright/test";


const PROTO = "fixture-widget-v2-bigger-2026-08-02.html";

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

/** Every fetch of the prototype's own bytes. One per genuine (re)load of the framed document. */
function countProtoFetches(page) {
  const seen = { n: 0 };
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/file") && url.includes(encodeURIComponent(PROTO))) seen.n += 1;
  });
  return seen;
}

/** Open the fixture record whose session carries an `iframe` fence. */
async function openTheProto(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();
  const frame = page.locator(".rich-iframe iframe").first();
  await expect(frame).toBeVisible({ timeout: 20_000 });
  return frame;
}

test("a prototype is not rebuilt, refetched or reloaded by a turn working underneath", async ({ page }) => {
  const errors = watchErrors(page);
  const fetches = countProtoFetches(page);

  const frame = await openTheProto(page);
  // Let the framed document finish loading AND finish reporting its height. A single "> 40" poll
  // catches it mid-settle — the document posts its height on load, on resize and on any content
  // change, so the first number over the placeholder is not the last one.
  await expect
    .poll(
      async () => {
        const first = await frame.evaluate((el) => el.clientHeight);
        await page.waitForTimeout(400);
        const second = await frame.evaluate((el) => el.clientHeight);
        return first === second && first > 40 ? first : -1;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(40);

  // Mark the NODE. An attribute on the element survives being moved; it does not survive being
  // rebuilt, which is what a full redraw does to every row.
  await frame.evaluate((el) => {
    el.dataset["steadyMark"] = "1";
  });
  const settled = fetches.n;
  const height = await frame.evaluate((el) => el.clientHeight);

  // ── a turn runs underneath the reader ─────────────────────────────
  const composer = page.locator("#composer-text");
  await composer.fill("slow one so the transcript redraws underneath");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("slow one so the transcript redraws", {
    timeout: 20_000,
  });
  await expect(page.locator("#transcript-body")).toContainText("stub reply:", { timeout: 40_000 });

  const still = page.locator(".rich-iframe iframe[data-steady-mark]");
  await expect(still, "the prototype is the SAME element after the turn").toHaveCount(1);
  expect(fetches.n - settled, "the prototype was refetched by the redraws").toBe(0);
  // NOT an equality against `height`. The framed document's own height protocol wanders on its own
  // — measured at 48, 72 and 180 across runs of this very spec with the element provably never
  // rebuilt and never refetched — so an equality here would pin someone else's defect, flakily.
  // What this build owes is that a redraw never puts the frame back to the fence's placeholder,
  // which is the collapse-and-grow the reader sees as flashing. The wander is a finding of its own.
  expect(height, "the settled height is not the placeholder").not.toBe(200);
  expect(
    await still.evaluate((el) => el.clientHeight),
    "and the redraws never sent it back to the placeholder",
  ).not.toBe(200);

  expect(errors, "no page errors while a prototype sits through a working turn").toEqual([]);
});

/**
 * A list of commands and the calls inside it are two different things (SPEC 212).
 *
 * `render.ts` stored a run's strip under its FIRST call's tool_use id — the same key that call's
 * own disclosure uses — so the two were one entry in one map. Opening the list opened its first
 * command on the next frame; closing that command closed the list. `journey2-input` cannot see it,
 * because it opens both inside one redraw-free window and both end up true.
 */
test("opening the list of commands does not open the commands inside it", async ({ page }) => {
  const errors = watchErrors(page);

  // The fixture RECORD, not the general stub project. Sending into the project `journey2-input`
  // drives leaves queue rows behind that outlive the run, and its own `.msg.pending` assertion is a
  // strict one — a spec that sends into a neighbour's project is a spec that fails the neighbour.
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();

  const composer = page.locator("#composer-text");
  await composer.fill("run some tools please");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub: tools done", { timeout: 20_000 });

  const strip = page.locator("details.steps").last();
  await expect(strip).toHaveCount(1);
  await strip.locator("summary").first().click();
  await expect(strip).toHaveJSProperty("open", true);

  const first = strip.locator("details.tool").first();
  await expect(first, "the first command is closed — he opened the LIST").toHaveJSProperty("open", false);

  // ── the redraws of a running turn are what made the two swap state ─
  await composer.fill("slow one to redraw underneath");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub reply: slow one to redraw", {
    timeout: 40_000,
  });

  await expect(strip, "the list he opened is still open").toHaveJSProperty("open", true);
  await expect(first, "and the command he did not open is still closed").toHaveJSProperty("open", false);

  // The other direction: closing a command he DID open must not close the list around it.
  await first.locator("summary").first().click();
  await expect(first).toHaveJSProperty("open", true);
  await first.locator("summary").first().click();
  await expect(first).toHaveJSProperty("open", false);
  await expect(strip, "closing a command does not close the list").toHaveJSProperty("open", true);

  expect(errors, "no page errors while folding and unfolding through a turn").toEqual([]);
});
