/**
 * The working indication, driven (SPEC 96) — the two LIES it exists to prevent, each with a stub
 * child written to tell it.
 *
 *   1. A hung turn must not look like a moving one. `quiet` starts one step and then says nothing
 *      at all; the pin watches the label admit how long it has been held, and watches that number
 *      grow. A spinner alone passes this test happily, which is the entire argument for the label.
 *   2. A burst of tools must not strobe. `burst` fires ten calls inside a second; the pin records
 *      every change of the label with a timestamp and asserts they are never closer than the floor.
 *
 * Both are two-sided on purpose: the hang pin first asserts the elapsed suffix is ABSENT while the
 * step is young, and the burst pin asserts the label is a real act rather than the old static word,
 * so neither can pass by the indication simply never saying anything.
 */

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const LOOM_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const PROJECT_KEY = LOOM_ROOT.replace(/[^A-Za-z0-9-]/g, "-");

/** The server's HOLD_MS, minus scheduling slack: a timer fires at or after its deadline, never before. */
const FLOOR_MS = 800;
const SLACK_MS = 100;

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

/** Record every CHANGE of the label, with the moment it changed. The 1s tick rewrites the same
 *  text repeatedly, so identical writes are not changes and are dropped here. */
async function recordLabel(page) {
  await page.evaluate(() => {
    window.__steps = [];
    const el = document.getElementById("composer-state");
    const note = () => {
      const text = el.textContent ?? "";
      const last = window.__steps[window.__steps.length - 1];
      if (last === undefined || last.text !== text) window.__steps.push({ t: performance.now(), text });
    };
    note();
    new MutationObserver(note).observe(el, { childList: true, characterData: true, subtree: true });
  });
}

const readLabels = (page) => page.evaluate(() => window.__steps);

async function boot(page) {
  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();
}

test("working: a burst of ten calls is one legible line, not ten", async ({ page }) => {
  const errors = watchErrors(page);
  await boot(page);
  await recordLabel(page);

  const composer = page.locator("#composer-text");
  await composer.fill("burst please");
  await composer.press("Enter");

  // Motion first — loom's only animation, and it runs only while a turn does.
  await expect(page.locator("#composer-spin")).toBeVisible({ timeout: 10_000 });
  // Then the fact. `working` alone is the state this project exists to replace, so the label has to
  // name the act the stub is actually performing.
  await expect(page.locator("#composer-state")).toContainText(/searches|needle/, { timeout: 10_000 });

  // WHERE it says it, which is the half this spec was missing. User, 2026-08-07: "you did it in
  // the bottom panel and you should have done it at the bottom of chat like in vs code." The move
  // that answered him kept the ids and only changed the parent, so every id-based assertion above
  // passed just as happily before it as after — the pin has to name the home, or it pins nothing.
  await expect(page.locator("#transcript-body #composer-state")).toHaveCount(1);
  await expect(page.locator("#composer #composer-state"), "not a composer control").toHaveCount(0);
  // And it is the last thing the CONVERSATION ends on. Since SPEC 199 the composer is the last
  // element of the scroller, so the row sits directly above it — re-derived rather than inherited:
  // "last child" would now be the composer and the assertion would pin the wrong thing.
  const place = await page.evaluate(() => {
    const row = document.getElementById("chat-working");
    const body = document.getElementById("transcript-body");
    return {
      inScroller: row?.parentElement === body,
      next: row?.nextElementSibling?.id ?? "",
      afterThat: row?.nextElementSibling?.nextElementSibling?.id ?? "",
    };
  });
  expect(place.inScroller, "the working row is in the transcript").toBe(true);
  expect(place.next, "directly above the composer's spacer").toBe("composer-anchor");
  expect(place.afterThat, "and the composer is the last thing after it").toBe("composer");

  await expect(page.locator("#transcript-body")).toContainText("stub: burst done", { timeout: 25_000 });
  await expect(page.locator("#composer-spin")).toBeHidden({ timeout: 10_000 });

  const all = (await readLabels(page)).filter((s) => s.text.length > 0);
  const everything = all.map((s) => s.text);
  expect(all.length, `the label said something: ${JSON.stringify(everything)}`).toBeGreaterThan(0);

  // The seam out of `working` is exempt, and only that one. `working` is not a step — it is what the
  // composer says between accepting the turn and hearing what the child is doing, and it is replaced
  // as soon as the first frame says. Flooring it would add 800ms of nothing to the start of every
  // turn; it can only ever happen once, so it cannot strobe. Measured at 57ms, deliberately kept.
  expect(everything.filter((t) => t === "working").length, "the placeholder shows at most once").toBeLessThanOrEqual(1);
  const steps = all.filter((s) => s.text !== "working");
  const shown = steps.map((s) => s.text);

  // THE anti-strobe assertion. Ten calls landed in ~600ms; unquieted that is ten labels inside one
  // second. Every change must be at least a floor apart from the one before it.
  for (let i = 1; i < steps.length; i += 1) {
    const gap = steps[i].t - steps[i - 1].t;
    expect(gap, `"${steps[i - 1].text}" → "${steps[i].text}" after ${Math.round(gap)}ms`).toBeGreaterThanOrEqual(
      FLOOR_MS - SLACK_MS,
    );
  }
  // And the collapse itself: ten same-kind calls are counted, not enumerated one by one.
  expect(shown.length, `ten calls collapsed into few lines: ${JSON.stringify(shown)}`).toBeLessThanOrEqual(6);

  expect(errors, errors.join("\n")).toEqual([]);
});

test("working: a step that stops moving says how long it has been stuck", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchErrors(page);
  await page.clock.install();
  await boot(page);

  const state = page.locator("#composer-state");
  const composer = page.locator("#composer-text");
  await composer.fill("quiet please");
  await composer.press("Enter");

  await expect(state).toContainText(/^running the thing that hangs/, { timeout: 10_000 });

  // Two-sided, and this is the half that makes the other half mean something: while the step is
  // young there is NO elapsed on the line. A pin that only checked for the suffix would pass on an
  // indication that showed a clock from the first millisecond — the exact headline User rejected.
  await page.clock.runFor(3_000);
  expect(await state.textContent()).not.toMatch(/·\s*\d+s/);

  // Past the overstay threshold the held label starts admitting its age — the floor was never
  // meant to be a ceiling.
  await page.clock.runFor(8_000);
  await expect(state).toContainText(/·\s*\d+s/, { timeout: 15_000 });
  const first = Number(/·\s*(\d+)s/.exec(await state.textContent())?.[1]);
  await page.clock.runFor(3_000);
  const later = Number(/·\s*(\d+)s/.exec(await state.textContent())?.[1]);
  // A frozen number would be its own lie: the hang has to look worse the longer it lasts.
  expect(later, `held ${first}s then ${later}s`).toBeGreaterThan(first);
  // The act is still named beside it — elapsed joined the line, it did not replace it.
  expect(await state.textContent()).toMatch(/^running the thing that hangs/);

  // Stop ends it, and the indication goes away with the turn rather than lingering.
  await page.locator("#composer-stop").click();
  await expect(page.locator("#transcript-body")).toContainText("stub: interrupted", { timeout: 20_000 });
  await expect(page.locator("#composer-spin")).toBeHidden({ timeout: 10_000 });
  await expect(state).toHaveText("");

  expect(errors, errors.join("\n")).toEqual([]);
});

test.describe("on the phone", () => {
  // 390×844 with real touch emulation: the working row sits at the bottom of the transcript, the
  // narrowest reading column loom has, and a tool target is a long string (SPEC 96, item 7).
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("working: a long act clips instead of spilling off the screen", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = watchErrors(page);
    await boot(page);

    const composer = page.locator("#composer-text");
    await composer.fill("quiet please");
    await composer.press("Enter");

    const state = page.locator("#composer-state");
    await expect(state).toContainText(/^running the thing that hangs/, { timeout: 10_000 });
    await expect(page.locator("#composer-spin")).toBeVisible();

    // The label is long enough to overflow on purpose, so this is a real test of the clip.
    const clipped = await state.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      right: el.getBoundingClientRect().right,
    }));
    expect(clipped.scroll, "the label really is wider than its box").toBeGreaterThan(clipped.client);
    expect(clipped.right, "and it does not spill past the screen").toBeLessThanOrEqual(390);

    // The composer's own controls are unaffected — they never shared a row with this in the first
    // place now that the indication lives in the transcript, not the toolbar.
    for (const id of ["#composer-send", "#composer-stop", "#composer-spin"]) {
      const box = await page.locator(id).boundingBox();
      expect(box, `${id} is on screen`).not.toBeNull();
      expect(box.x + box.width, `${id} right edge`).toBeLessThanOrEqual(390);
      expect(box.y + box.height, `${id} bottom edge`).toBeLessThanOrEqual(844);
    }

    await page.locator("#composer-stop").click();
    await expect(page.locator("#transcript-body")).toContainText("stub: interrupted", { timeout: 20_000 });

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
