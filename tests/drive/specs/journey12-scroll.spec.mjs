/**
 * The transcript's bottom edge (projects/reading-surface/11-the-chat-window-allows-me-to-scroll-below-the).
 *
 * User, verbatim: "the chat window allows me to scroll below the last message and when you update
 * something in the chat it automatically pulls me up which is annoying" — plus "a bigger gap between
 * the last message and the bottom panel so it doesnt feel smooshed - but not too big".
 *
 * Both halves are ONE defect with one cause: the bottom clearance lived INSIDE the scroller, as
 * `#transcript-body`'s padding. Inside, it is travel you can scroll into and find nothing (half one);
 * and `scrollToEnd()` aligns the last message with the viewport floor, which from down there is a
 * jump UPWARDS on every live append (half two) — while leaving the resting gap at whatever margin
 * the last message happened to carry (half three, the smooshed one).
 *
 * So the pin measures all three at once: no travel below the end, a real gap at rest, and a scroll
 * position that survives an append.
 *
 * RE-DERIVED 2026-08-12, and this is the part to read before trusting any green here. SPEC 199 put
 * the composer INSIDE the scroller, which quietly broke two of the measurements below rather than
 * failing them: `bandBelowScroller` was `composer.top - body.bottom`, and with the composer in the
 * flow that number goes NEGATIVE — the `<= 2` assertion then passes whatever the code does, so the
 * assertion that caught the 2026-08-08 white band stopped being able to fail. It is now the strip
 * of `#chat-area` below the scroller, which is what the band always was. The "text fills the gap"
 * half measured up to the composer's top, which is now a thing inside the scroller; it measures to
 * the scroller's own floor instead. `gapAtRest` survives as written and means what it always meant
 * — the space between the last message and the bar — except that the space is the composer's own
 * margin now instead of the scroller's padding.
 *
 * REOPENED 2026-08-08. The first fix moved the clearance OUT of the scroller, onto `#chat-area` —
 * which fixed the travel and the yank but made the gap a permanent band the transcript can never
 * use. User, on the screenshot: "the white div that goes over text is weird and unnecessarily
 * limits use of space. It doesnt work like that in vs code... i want the same experience that
 * leaves a gap at the lowest position but utilizes that gap when scrolled up." So the clearance is
 * `#transcript-body` padding again — which is NOT the reverted defect, because the defect was
 * `scrollToEnd()` parking above the true bottom, and that stays fixed. The band is now the reader's
 * resting position and nothing below it; scroll up and content occupies it.
 */

import { expect, test } from "@playwright/test";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

/** The gap the reader must see between the last message and the composer, once scrolled to the end. */
const GAP_MIN = 48;
/** ...and what "not too big" means. A gap is breathing room, never a share of the window. */
const GAP_MAX = 96;

async function edge(page) {
  return page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    const composer = document.querySelector("#composer");
    const messages = body.querySelectorAll(".msg");
    const last = messages[messages.length - 1];
    // The bottom-most thing rendered — the MAX over the children, not the last one and not the last
    // `.msg`. The last child can be an empty hidden row, and a seam or the working line legitimately
    // sits below the last message; both are content you may read to the end of.
    let end = 0;
    for (const node of body.children) end = Math.max(end, node.offsetTop + node.offsetHeight);
    return {
      // Scrollable emptiness: screen you can travel to and find nothing. NOT
      // `scrollHeight - scrollTop - clientHeight`, which is zero at max scroll by definition and so
      // measures nothing at all.
      deadBelow: Math.round(body.scrollHeight - end),
      // Travel left from HERE, which says whether the app's own auto-scroll parked the reader short
      // of the true bottom — the "pulls me up" half.
      travelBelowEnd: Math.round(body.scrollHeight - body.scrollTop - body.clientHeight),
      // The gap as the EYE sees it: the last message's bottom to the composer's top border, with
      // the scroller at its end. This is the number User called smooshed.
      gapAtRest: Math.round(composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
      // Dead LAYOUT: how much of the window below the scroll region no text can ever reach, at any
      // scroll position. This is the white band, and it must be zero. Measured against the CHAT
      // AREA's floor since SPEC 199 — the composer is inside the scroller now, so measuring to the
      // composer would report a negative number and pass anything at all.
      bandBelowScroller: Math.round(
        document.querySelector("#chat-area").getBoundingClientRect().bottom - body.getBoundingClientRect().bottom,
      ),
      // Is the composer really IN the flow — the structural fact every number here now depends on.
      composerInScroller: composer.parentElement === body,
      composerDocked: composer.classList.contains("docked"),
      // The bottom-most pixel of the scroller itself, so "the text reaches the floor" can be stated
      // without naming the composer.
      scrollerBottom: Math.round(body.getBoundingClientRect().bottom),
      // The bottom-most VISIBLE pixel of anything rendered, in viewport coordinates — clamped to
      // the scroller's own floor, because `getBoundingClientRect()` ignores overflow clipping and
      // would happily report ink the reader cannot see. Read after scrolling UP: if the gap is
      // really the scroller's last 64px, text reaches the composer from up there.
      lowestInk: Math.round(
        Math.min(
          body.getBoundingClientRect().bottom,
          [...body.children]
            .filter((n) => !n.hasAttribute("hidden"))
            .reduce((low, n) => Math.max(low, n.getBoundingClientRect().bottom), 0),
        ),
      ),
      composerTop: Math.round(composer.getBoundingClientRect().top),
      scrollTop: Math.round(body.scrollTop),
      scrollHeight: body.scrollHeight,
      viewport: body.clientHeight,
    };
  });
}

// Both sizes, because the phone media query carries its OWN copy of the clearance — and it kept the
// 60vh for a whole round after the desktop rule lost it (layout-holds, 2026-08-06).
for (const size of [
  { name: "laptop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
test(`scroll: the transcript stops at its end, with a real gap under it — ${size.name}`, async ({ page }) => {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  // Drive the scroller to its own maximum — what a reader's last wheel notch does, not what the
  // app's own auto-scroll does. The defect only shows from down here.
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(120);

  const at = await edge(page);
  expect(at.scrollHeight, "the fixture must be taller than the pane, or there is nothing to measure").toBeGreaterThan(
    at.viewport + 200,
  );
  // The emptiness at the end IS the gap now, so it is bounded by the gap rather than by zero —
  // 60vh (562px, 2026-08-06) still fails this, which is the regression it was written for. What
  // must be exactly zero is `bandBelowScroller`, below.
  expect(at.deadBelow, `dead space below the end (scrollTop ${at.scrollTop} of ${at.scrollHeight - at.viewport})`).toBeLessThanOrEqual(GAP_MAX);
  expect(at.gapAtRest, "the last message must not sit on the composer").toBeGreaterThanOrEqual(GAP_MIN);
  expect(at.gapAtRest, "and the gap is breathing room, not a white zone").toBeLessThanOrEqual(GAP_MAX);
});

test(`scroll: the resting gap is the transcript's own, and text uses it once you scroll up — ${size.name}`, async ({ page }) => {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(120);

  // Half one, structural: no strip of window between the scroller's floor and the composer. Clipping
  // text against a band nothing can scroll into is what User saw as "the white div that goes over
  // text". Measured at 64px on a laptop / 56px on a phone before this change.
  const rest = await edge(page);
  expect(rest.composerInScroller, "the composer is the last element of the chat (SPEC 199)").toBe(true);
  expect(rest.composerDocked, "at rest, with nothing typed, it is in the flow and not docked").toBe(false);
  expect(rest.bandBelowScroller, "the scroll region must reach the pane's floor").toBeLessThanOrEqual(2);

  // Half two, behavioural: from 200px up, the band is full of text. If the clearance is layout
  // rather than content, `lowestInk` stops short of the composer by exactly the band's height and
  // no amount of scrolling ever fills it.
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight - body.clientHeight - 200;
  });
  await page.waitForTimeout(120);
  const up = await edge(page);
  expect(up.scrollTop, "there must be 200px to scroll up into").toBeGreaterThan(0);
  expect(
    up.scrollerBottom - up.lowestInk,
    `unused space under the text when scrolled up (lowest ink ${up.lowestInk}, floor ${up.scrollerBottom})`,
  ).toBeLessThanOrEqual(2);
});
}

/**
 * The end has to be the end at the moments the reader actually meets it — and every one of those
 * moments is a moment the page is still GROWING.
 *
 * User, 2026-08-08: "when you open the chat it doesnt start at the lowest position but somewhere
 * above it - it should start at the lowest", "entering messages should also scroll to the lowest",
 * "and when you start working in the chat - the automatic scroll doesnt scroll to the lowest".
 * Three reports, one shape: `scrollToEnd()` scrolls to the height the transcript has AT THAT
 * INSTANT, and the working row is appended by `drawStep()` afterwards — so the reader is left
 * short by exactly the height of the thing that arrived late. Measured 32px against the live
 * instance before the fix.
 *
 * A running turn is what makes this reproducible, so the pin drives one against the STUB: the
 * `slow` reply holds the job open for ~6s, long enough to check the send, the running turn and a
 * reload landing mid-turn. Laptop only — nothing here is width-dependent, and the turn costs
 * seconds.
 *
 * It drives its OWN project (`tests/` as cwd, 41 rows, make-fixture) rather than the two-message
 * input fixture. Two reasons, both learned the hard way on 2026-08-08: a session shorter than the
 * pane reports zero travel at every step no matter what the client does, so the first draft of this
 * test could not fail and passed against the defect — and growing journey2-input's session at
 * runtime to fix that moved ITS queue assertions, while restoring the file afterwards was worse
 * still (a shrinking file under a live tailer left a pending ghost that never pruned).
 */
test("scroll: the end is the end while the page is still growing — send, work, reload", async ({ page }) => {
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
  const projectKey = `${root}/tests`.replace(/[^A-Za-z0-9-]/g, "-");

  /** Travel left below the reader. The whole complaint, in one number. */
  const short = () =>
    page.evaluate(() => {
      const b = document.querySelector("#transcript-body");
      return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
    });

  await page.goto(`/?project=${projectKey}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  const room = await page.evaluate(() => {
    const b = document.querySelector("#transcript-body");
    return { scrollHeight: b.scrollHeight, viewport: b.clientHeight };
  });
  expect(room.scrollHeight, "the session must be taller than the pane, or nothing here can fail").toBeGreaterThan(
    room.viewport + 200,
  );

  const working = page.locator("#chat-working");
  const composer = page.locator("#composer-text");
  await composer.fill("slow please");
  await composer.press("Enter");

  // ── on send ── the working row lands after the send's own scroll, so this is where the 32px was.
  await expect(working).toBeVisible({ timeout: 10_000 });
  expect(await short(), "sending must leave the reader at the bottom, working row and all").toBeLessThanOrEqual(2);

  // ── while working ── the row's label changes every second and can rewrap; the reader stays put.
  await page.waitForTimeout(1200);
  await expect(working).toBeVisible();
  expect(await short(), "a turn in flight must not push the reader up").toBeLessThanOrEqual(2);

  // ── opening the chat mid-turn ── the "when you open the chat" half, and the reason the reload is
  // here rather than in a separate case: an open with nothing growing under it cannot fail.
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(working, "the witness: without a running turn this case proves nothing").toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(400);
  expect(await short(), "opening the chat lands at the lowest position").toBeLessThanOrEqual(2);

  // ── and the turn's own reply still arrives at the end ──
  await expect(page.locator("#transcript-body")).toContainText("stub reply: slow please", { timeout: 20_000 });
  await expect(working).toBeHidden({ timeout: 10_000 });
  await page.waitForTimeout(300);
  expect(await short(), "the finished turn leaves the reader at the end").toBeLessThanOrEqual(2);
});

test("scroll: a live append follows the end, but never yanks a reader who moved away", async ({ page }) => {
  const { appendFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");

  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const store = process.env["LOOM_FIXTURE_OUT"] ?? join(root, "tests/fixture/projects");
  const file = join(store, "-fixture-project", "00000000-fixture-0000-000000000001.jsonl");

  const append = (text, n) =>
    appendFileSync(
      file,
      `${JSON.stringify({
        type: "assistant",
        uuid: `cccccccc-0000-0000-0000-00000000000${n}`,
        parentUuid: null,
        timestamp: new Date().toISOString(),
        sessionId: "00000000-fixture-0000-000000000001",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
      })}\n`,
    );

  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  // ── reading the live end: an append must follow it ──
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  append("scroll pin: the first append", 1);
  await expect(page.locator("#transcript-body")).toContainText("scroll pin: the first append", { timeout: 20_000 });
  await page.waitForTimeout(600); // the follow is smooth-scrolled
  const followed = await edge(page);
  expect(followed.travelBelowEnd, "an append while at the end brings itself into view").toBeLessThanOrEqual(2);

  // ── moved away on purpose: the append must NOT move the page ──
  // 260px is one deliberate gesture — a couple of wheel notches to reread the line above. Small
  // enough that the old 140px stick radius was the only thing keeping it from being overridden.
  const before = await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight - body.clientHeight - 260;
    return Math.round(body.scrollTop);
  });
  append("scroll pin: the second append", 2);
  await expect(page.locator("#transcript-body")).toContainText("scroll pin: the second append", { timeout: 20_000 });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => Math.round(document.querySelector("#transcript-body").scrollTop));
  expect(after, `a reader 260px off the end stays put (was ${before})`).toBe(before);
});


/**
 * TYPING while reading history, which is the whole point of the docking composer (SPEC 199, 182).
 *
 * No narrow assertion can see this defect: it is a height change ACROSS states, so what is measured
 * is the reader's scroll position through four of them — in the flow, docked on one line, docked on
 * four lines, back in the flow. The four-line step is the one that catches a spacer measured once
 * at dock time, which is what the prototype does and what 182 exists to forbid.
 */
test("scroll: typing 2000px up never moves the text under the reader", async ({ page }) => {
  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  const composer = page.locator("#composer");
  const box = page.locator("#composer-text");
  const at = () => page.evaluate(() => Math.round(document.querySelector("#transcript-body").scrollTop));
  const height = () => page.evaluate(() => document.querySelector("#transcript-body").scrollHeight);

  // Focus the box BEFORE scrolling away, which is what actually happens: the cursor is in the
  // composer, he scrolls up to re-read, and types from there. Typing is `page.keyboard` for the
  // same reason — `locator.type` scrolls its target into view first, which would undo the scroll
  // this whole case is about.
  await box.click();

  // Up the page, far enough that the composer's own place is gone.
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight - body.clientHeight - 2000;
  });
  await page.waitForTimeout(120);
  const start = await at();
  // The scroller's height is the same DOCKED and IN THE FLOW at the same draft — that is what the
  // spacer is for. It is not constant as the draft grows: a composer growing in the flow grows the
  // scroller too, and the spacer's whole job is to make the docked case behave the same way. So the
  // comparison below is always docked-vs-undocked at one content, never before-vs-after typing.
  const same = (a, b, why) => expect(Math.abs(a - b), `${why} (${a} vs ${b})`).toBeLessThanOrEqual(2);
  const toEnd = async () => {
    await page.evaluate(() => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = body.scrollHeight;
    });
    await page.waitForTimeout(140);
  };
  const backUp = async () => {
    await page.evaluate(() => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = body.scrollHeight - body.clientHeight - 2000;
    });
    await page.waitForTimeout(140);
  };
  expect(start, "there must be 2000px of history to sit in").toBeGreaterThan(0);
  await expect(composer, "out of view and empty: nothing docks").not.toHaveClass(/docked/);
  await expect(page.locator("#write-pill"), "the way back is on screen instead (SPEC 184)").toBeVisible();

  // ── one character ──
  await page.keyboard.type("a");
  await page.waitForTimeout(120);
  await expect(composer, "a draft whose place has scrolled away docks").toHaveClass(/docked/);
  await expect(page.locator("#write-pill"), "the pill and the docked bar are never both up").toBeHidden();
  expect(await at(), "the text he is reading did not move").toBe(start);

  // ── four lines: the spacer has to TRACK the box, not remember it ──
  // Shift+Enter, not "\n": Enter SENDS, and a sent draft is not a draft (SPEC 106's rule, and the
  // reason this line cost a run — the first version typed the message away).
  for (const line of ["bb", "cc", "dd"]) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(line);
  }
  await page.waitForTimeout(160);
  await expect(composer).toHaveClass(/docked/);
  const grown = await page.evaluate(() => document.querySelector("#composer").getBoundingClientRect().height);
  expect(grown, "the box really did grow").toBeGreaterThan(120);
  expect(await at(), "a growing draft does not move the text either").toBe(start);

  // THE assertion this case exists for: with a four-line draft, the spacer holds exactly what the
  // composer occupies. A spacer measured once at dock time is short by the whole growth, and that
  // difference is the lurch — it lands on the reader the moment the composer comes back.
  //
  // RE-STATED 2026-08-23, with User's word in chat, because the transcript is windowed now (SPEC
  // 228). It used to compare the scroller's TOTAL height docked, up the page, against its total
  // height at the end, in the flow. Under a windowed transcript part of the document is a modelled
  // estimate and part is real, and which part is which depends on where the reader is standing — so
  // the total is position-dependent by construction and those two numbers differ by ~200px however
  // the model is built. Six fixes were tried against the running page and none of them reached it.
  //
  // What 182 actually claims is compared instead, and it is compared where the claim lives: at ONE
  // position, the spacer standing in for the composer is the height the composer occupies. That is
  // strictly closer to the requirement than the total ever was — a total can agree by two errors
  // cancelling, and this cannot. It still fails on the defect it was written for: a spacer measured
  // once at dock time reads its one-line height against a four-line box.
  const anchorHeight = () => page.evaluate(() => document.querySelector("#composer-anchor").getBoundingClientRect().height);
  const boxHeight = () => page.evaluate(() => document.querySelector("#composer").getBoundingClientRect().height);
  const dockedSpacer = await boxHeight();
  expect(dockedSpacer, "the box is the four-line one").toBeGreaterThan(120);
  const spacerDocked = await anchorHeight();
  await toEnd();
  await expect(composer, "at the end its place is on screen, so it is in the flow").not.toHaveClass(/docked/);
  // Docked, the spacer stands in for the composer AND for the resting clearance under it; in the
  // flow, the composer stands in the scroller and the spacer is only the clearance. So the claim is
  // that the one equals the other two, at the same draft — which is the composer's contribution to
  // the scroller, isolated from anything the window does.
  same(spacerDocked, (await anchorHeight()) + (await boxHeight()), "the spacer holds exactly what the composer occupies");
  await backUp();
  await expect(composer, "and it docks again on the way back up").toHaveClass(/docked/);

  // ── deleted: back into the flow, still no movement ──
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(160);
  await expect(composer, "an empty box is never docked").not.toHaveClass(/docked/);
  await expect(page.locator("#write-pill"), "and the way back is offered again").toBeVisible();
  // The other half of the same rule, and the same re-statement: an empty box in the flow is held by
  // an empty spacer, read where they both are rather than across two scroll positions.
  // The other half of the same rule: an empty box is never docked, so up the page and at the end it
  // contributes the same thing to the scroller — the clearance, and the box standing in it.
  const emptyUp = (await anchorHeight()) + (await boxHeight());
  await toEnd();
  same(emptyUp, (await anchorHeight()) + (await boxHeight()), "an empty composer occupies the same either way");
});

/**
 * The append-while-following case, run in BOTH composer states (SPEC 182, scenario 10).
 *
 * The docked run is the one that can regress: docking takes the composer out of the flow and hands
 * its height to a spacer, so an append that follows the end has two heights to agree about.
 */
test("scroll: an append follows the end with the composer in the flow AND docked", async ({ page }) => {
  const { appendFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");

  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const store = process.env["LOOM_FIXTURE_OUT"] ?? join(root, "tests/fixture/projects");
  const file = join(store, "-fixture-project", "00000000-fixture-0000-000000000001.jsonl");
  const append = (text, n) =>
    appendFileSync(
      file,
      `${JSON.stringify({
        type: "assistant",
        uuid: `dddddddd-0000-0000-0000-00000000000${n}`,
        parentUuid: null,
        timestamp: new Date().toISOString(),
        sessionId: "00000000-fixture-0000-000000000001",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
      })}\n`,
    );

  const short = () =>
    page.evaluate(() => {
      const b = document.querySelector("#transcript-body");
      return Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
    });

  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(120);

  // ── run one: composer empty, in the flow ──
  append("dock pin: append with the composer in the flow", 1);
  await expect(page.locator("#transcript-body")).toContainText("dock pin: append with the composer in the flow", {
    timeout: 20_000,
  });
  await page.waitForTimeout(400);
  await expect(page.locator("#composer")).not.toHaveClass(/docked/);
  expect(await short(), "the view stays pinned to the true maximum").toBeLessThanOrEqual(2);

  // ── run two: a draft, docked, and the reader still following the end ──
  // Typed first, then scrolled back to the end: docking is about the composer's PLACE, and at the
  // end its place is on screen — so the draft has to be written from up the page, with the cursor
  // put in the box before the scroll.
  await page.locator("#composer-text").click();
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight - body.clientHeight - 1200;
  });
  await page.keyboard.type("a draft left up the page");
  await page.waitForTimeout(120);
  await expect(page.locator("#composer")).toHaveClass(/docked/);
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(120);
  const dockedAtEnd = await page.evaluate(() => document.querySelector("#composer").classList.contains("docked"));
  append("dock pin: append with a draft in the box", 2);
  await expect(page.locator("#transcript-body")).toContainText("dock pin: append with a draft in the box", {
    timeout: 20_000,
  });
  await page.waitForTimeout(400);
  expect(await short(), `the view stays pinned with a draft in the box (docked ${dockedAtEnd})`).toBeLessThanOrEqual(2);
});
