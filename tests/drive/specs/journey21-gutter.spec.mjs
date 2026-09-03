/**
 * The marker gutter down the right edge of the chat (SPEC 192) — experimental, and the requirement
 * that comes out first if it costs any of 177–191.
 *
 * Two things are worth driving in a browser rather than asserting in a property. The counting rule
 * is one: `client/gutter.ts` decides what a point IS, but only the page can say whether the thing it
 * decides from is what the renderer actually puts in a turn — a point is now a turn carrying a build
 * plan or a framed prototype, and `.rich-plan` / `.rich-iframe` are classes the block registry owns,
 * not the gutter. That is a claim about the DOM. The other is the promise this requirement is on
 * probation for: the
 * gutter must not touch the transcript's layout. It floats over `#chat-area` outside the scroller,
 * so the scroller's height, its children and the resting gap are the same with it as without — and
 * those are the exact numbers 199 and 182 are pinned on.
 */

import { expect, test } from "@playwright/test";
import { collect } from "../reveal.mjs";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

/**
 * Wait until the whole transcript is drawn, not just the tail.
 *
 * A session opens on its last turns and the history arrives on the frame after (SPEC 214), so a
 * spec that counts rows the moment the first one appears is counting a paint in progress. Watching
 * the count SETTLE says nothing about how the drawing is staged, which is what keeps this from
 * becoming a second copy of the rule it is waiting on.
 */
async function drawn(page) {
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();
  await page.waitForFunction(
    () => {
      const n = document.querySelectorAll("#transcript-body .msg").length;
      const was = window.__drawnCount;
      window.__drawnCount = n;
      return was === n && n > 0;
    },
    null,
    { polling: 250, timeout: 20_000 },
  );
}

test("gutter: a point per embedded artifact, and none for an ordinary message", async ({ page }) => {
  await page.goto(FIXTURE);
  await drawn(page);

  // Swept, not read off one screen. The gutter is a map of the SESSION and the transcript is
  // windowed (SPEC 228), so the artifacts it must agree with are all of them, including the ones in
  // turns that are not currently nodes — which is the whole claim, and `journey33` drives it against
  // a session far too long to sweep.
  const withArtifact = await collect(page, ".rich-plan, .rich-iframe");
  const plans = await collect(page, ".rich-plan");
  const protos = await collect(page, ".rich-iframe");
  const anyRow = await collect(page, ".msg");
  const counts = {
    points: await page.locator("#gutter .mm").count(),
    withArtifact: withArtifact.size,
    plans: plans.size,
    protos: [...protos].filter((uuid) => !plans.has(uuid)).length,
    planPoints: await page.locator("#gutter .mm.plan").count(),
    protoPoints: await page.locator("#gutter .mm.proto").count(),
    // Everything a gutter drawn per MESSAGE would have marked — the count this rule replaced.
    plain: [...anyRow].filter((uuid) => !withArtifact.has(uuid)).length,
  };

  expect(counts.withArtifact, "the fixture must carry artifacts, or this proves nothing").toBeGreaterThan(2);
  // Two-sided, and this is the half that fails on the old rule: a transcript whose turns are mostly
  // ordinary messages must contribute NO points for them, so a build that marked every message
  // would read `plain + withArtifact` here and fail on the very first assertion.
  expect(counts.plain, "the fixture must also carry ordinary turns").toBeGreaterThan(2);
  expect(counts.points, "one point per turn carrying an artifact, and nothing else").toBe(counts.withArtifact);
  expect(counts.planPoints, "a build plan is a diamond").toBe(counts.plans);
  expect(counts.protoPoints, "a prototype is a square").toBe(counts.protos);
});

test("gutter: the point being read is ringed, and at the end it is the last one", async ({ page }) => {
  await page.goto(FIXTURE);
  await drawn(page);

  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(200);

  const atEnd = await page.evaluate(() => {
    const dots = [...document.querySelectorAll("#gutter .mm")];
    return { total: dots.length, on: dots.map((d, i) => (d.classList.contains("on") ? i : -1)).filter((i) => i >= 0) };
  });
  expect(atEnd.on, "exactly one point is ringed").toHaveLength(1);
  expect(atEnd.on[0], "at the end of the scroller the LAST point is the one being read").toBe(atEnd.total - 1);

  // Up the page: the ring follows him, and it is no longer the last point.
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  const atTop = await page.evaluate(() => {
    const dots = [...document.querySelectorAll("#gutter .mm")];
    return { total: dots.length, on: dots.map((d, i) => (d.classList.contains("on") ? i : -1)).filter((i) => i >= 0) };
  });
  expect(atTop.on, "still exactly one").toHaveLength(1);
  expect(atTop.on[0], "and it moved off the last point").toBeLessThan(atTop.total - 1);
});

test("gutter: clicking a point brings its turn onto the screen", async ({ page }) => {
  await page.goto(FIXTURE);
  await drawn(page);
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(200);

  const before = await page.evaluate(() => Math.round(document.querySelector("#transcript-body").scrollTop));
  await page.locator("#gutter .mm").first().click();
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => Math.round(document.querySelector("#transcript-body").scrollTop));
  expect(after, "the first point is near the top of the conversation, so the click travels").toBeLessThan(before);
});

test("gutter: it floats over the chat and changes nothing about the transcript's layout", async ({ page }) => {
  await page.goto(FIXTURE);
  await drawn(page);
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(200);

  const withIt = await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    return {
      inScroller: document.querySelector("#gutter").parentElement.id,
      children: body.children.length,
      scrollHeight: body.scrollHeight,
      travelBelowEnd: Math.round(body.scrollHeight - body.scrollTop - body.clientHeight),
    };
  });
  expect(withIt.inScroller, "the gutter hangs off the chat area, never off the scroller").toBe("chat-area");

  // Take it away and measure again: the scroller must not notice.
  const without = await page.evaluate(() => {
    document.querySelector("#gutter").remove();
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
    return { children: body.children.length, scrollHeight: body.scrollHeight };
  });
  expect(without.children, "no point of it is a child of the scroller").toBe(withIt.children);
  expect(without.scrollHeight, "and it adds no height a reader could scroll into").toBe(withIt.scrollHeight);
  expect(withIt.travelBelowEnd, "the end is still the end with the gutter up").toBeLessThanOrEqual(2);
});

/**
 * No point can cover another, or the click he aims at one turn lands on the turn below it.
 *
 * The placement is proportional, so two turns 30px apart in a 20,000px transcript land on the same
 * pixel of a 900px gutter — and the lower dot, drawn last, wins. It was the FIRST point of the
 * fixture that had become unclickable, which is why the click spec above timed out for days
 * (`<button class="mm"> intercepts pointer events`) rather than failing on its assertion.
 */
test("gutter: no point sits on top of another", async ({ page }) => {
  await page.goto(FIXTURE);
  await drawn(page);

  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll("#gutter .mm")].map((dot) => {
      const box = dot.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }),
  );
  expect(boxes.length, "the fixture has enough points to crowd").toBeGreaterThan(3);
  const rail = await page.locator("#gutter").boundingBox();
  // A full hit box, or as much of one as the gutter can afford when there are more points than
  // room — the same rule `spreadGutter` places by, asserted from the outside.
  const gap = Math.min(14, rail.height / boxes.length) - 0.5;
  for (let i = 1; i < boxes.length; i += 1) {
    expect(boxes[i].top - boxes[i - 1].top, `point ${i} must clear point ${i - 1}`).toBeGreaterThanOrEqual(gap);
  }

  // Two-sided: every point is still ON the gutter, so separating them cannot have pushed the last
  // ones off the bottom.
  for (const box of boxes) {
    expect(box.top).toBeGreaterThanOrEqual(rail.y - 8);
    expect(box.bottom).toBeLessThanOrEqual(rail.y + rail.height + 8);
  }

  // And the point the click spec above reaches for is genuinely reachable: nothing else is on top
  // of it at its own centre.
  const hitsItself = await page.locator("#gutter .mm").first().evaluate((dot) => {
    const box = dot.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return dot.contains(at);
  });
  expect(hitsItself, "the first point is the element under its own centre").toBe(true);
});
