/**
 * Bring something into the transcript that the window has not built yet (SPEC 228).
 *
 * The transcript mounts only the turns around the reader, so a spec that asks for an element deep in
 * a long fixture is asking for a node that does not exist until somebody scrolls to it. That is the
 * behaviour, not a defect — a reader reaches an image five hundred turns back by scrolling to it —
 * and this is the same act, driven.
 *
 * Returns true once the selector matches. Sweeps from the END backwards, because that is where a
 * session opens and the shortest path to most things.
 */
export async function reveal(page, target, steps = 24) {
  // A LOCATOR is as good a target as a selector here — and half the things worth reaching for are
  // addressed by a locator the spec computed (`.last()`, a filter). The sweep only ever asks "is it
  // there yet", which a locator answers. Until 2026-08-23 a locator target was not swept at all, so
  // a chip that had scrolled out of the window read as "not clickable where it sits" after ten
  // seconds of waiting for a redraw that was never going to mount it.
  const at = typeof target === "string" ? page.locator(target) : target;
  if ((await at.count()) > 0) return true;
  for (let i = steps; i >= 0; i -= 1) {
    await page.evaluate((fraction) => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = Math.round(body.scrollHeight * fraction);
    }, i / steps);
    await page.waitForTimeout(120);
    if ((await at.count()) > 0) return true;
  }
  return false;
}

/**
 * Wait until the transcript has stopped changing shape.
 *
 * Mounting a turn brings its images and its rich blocks with it, and those settle their heights
 * after they load (SPEC 155) — so for a moment after the window moves the page is still growing, and
 * anything measured or clicked in that moment is being aimed at a moving target. Playwright's own
 * actionability check calls this "element is not stable" and retries until the test times out.
 */
export async function settle(page, tries = 8) {
  let last = "";
  for (let i = 0; i < tries; i += 1) {
    const now = await page.evaluate(() => {
      const body = document.querySelector("#transcript-body");
      // The POSITION belongs in this fingerprint as much as the height does. A redraw that mounts
      // history replaces its estimated heights with measured ones, and the scroll anchor then moves
      // the scroller to keep the reader's row where it was (SPEC 211/228) — so a page can be done
      // growing and still be travelling. Waiting only on the height declared it settled mid-flight,
      // and the element this was called for was somewhere else by the time it was measured.
      return `${Math.round(body.scrollHeight)}:${Math.round(body.scrollTop)}:${body.querySelectorAll(".msg").length}`;
    });
    if (now === last) return true;
    last = now;
    await page.waitForTimeout(120);
  }
  return false;
}

/**
 * Walk the whole transcript once, so the window's height model is measured rather than estimated.
 *
 * A turn that has never been mounted is in the model at an ESTIMATE, and an estimate that is wrong
 * by a screen puts the plan's idea of where the reader is standing a screen away from where they
 * actually are — so aiming at a row can unmount it, which is not something more aiming fixes
 * (measured 2026-08-23: the fixture's image grid, 3,400px of correction, gone at the third step and
 * never mounted again). One pass replaces every estimate it passes with a measurement, and the
 * model is then exact for everything the aim has to cross. It costs about three seconds and it is
 * only paid when the first approach has already failed.
 */
export async function warm(page, steps = 24) {
  for (let i = steps; i >= 0; i -= 1) {
    await page.evaluate((fraction) => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = Math.round(body.scrollHeight * fraction);
    }, i / steps);
    await page.waitForTimeout(90);
  }
  for (let i = 0; i <= steps; i += 1) {
    await page.evaluate((fraction) => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = Math.round(body.scrollHeight * fraction);
    }, i / steps);
    await page.waitForTimeout(90);
  }
}

/**
 * Put something in the MIDDLE of the transcript and let the page settle there.
 *
 * The replacement for `locator.scrollIntoViewIfNeeded()` on transcript content. That call scrolls
 * just enough to bring the element to the nearest EDGE of the viewport — which under a windowed
 * transcript (SPEC 228) is the edge of what is mounted, so the redraw it triggers can unmount the
 * very thing it was scrolling to, and the next `boundingBox()` reads null. Centring puts it well
 * inside the mounted band, where nothing that follows will move it.
 */
export async function bring(page, target) {
  // `target` is a selector string or a Playwright locator — the second form because half the things
  // worth reaching for here are addressed by a locator the spec computed.
  const locator = typeof target === "string" ? page.locator(target).first() : target.first();
  const box = (node) => {
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    // The CENTRE has to be on screen, not the whole box: something taller than the window is still
    // perfectly clickable, and demanding the whole of it fits rejects a grid tile that is right
    // there.
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) return null;
    return { x, y };
  };
  // EVERY reach into the page is given a short deadline of its own. A `locator.evaluate` whose
  // element is not mounted waits for Playwright's default timeout — thirty seconds — and under a
  // windowed transcript (SPEC 228) a redraw can unmount the row between `count()` and the call that
  // follows it. Three of those stalls is the whole 90s test budget, spent waiting for something a
  // four-second sweep would have found; it read as "the fixture's image grid is unreachable"
  // (journey13, 2026-08-23). A miss is a retry, not a wait.
  const REACH = { timeout: 2_000 };
  let warmed = false;
  // ONE SCREEN AT A TIME, never one jump. `scrollIntoView` travels the whole distance at once, and
  // the redraw that follows mounts every turn it passed over — whose estimated heights are then
  // replaced by measured ones, so the scroll anchor moves the reader by whatever that was worth
  // (SPEC 211/228). Measured 2026-08-23 on the fixture's image grid: a 3,400px correction, landing
  // 1,400px past the target with the target itself unmounted, and five identical retries after it.
  // A step the size of the screen keeps each correction small enough that the next step still has
  // something to aim at — which is also what a reader's hand does.
  const step = () =>
    locator
      .evaluate((node) => {
        const body = document.querySelector("#transcript-body");
        const b = body.getBoundingClientRect();
        const r = node.getBoundingClientRect();
        const want = r.top - b.top - (b.height - r.height) / 2;
        body.scrollTop += Math.max(-b.height * 0.6, Math.min(b.height * 0.6, want));
        return true;
      }, undefined, REACH)
      .catch(() => false);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    // Swept only when it is not there at all — a sweep is seconds, and several do not fit in a
    // test's budget.
    if ((await locator.count()) === 0) {
      if (!(await reveal(page, target))) return null;
      continue;
    }
    const at = await locator.evaluate(box, undefined, REACH).catch(() => null);
    if (at !== null) return at;
    if (!(await step())) continue;
    await settle(page, 4);
    // Eight steps is more than the distance any aim needs; past that the model is what is wrong,
    // not the aim, and only a full pass fixes a model.
    if (attempt === 8 && !warmed) {
      warmed = true;
      await warm(page);
    }
  }
  return null;
}

/**
 * Every turn in the session that matches a selector, gathered over a full sweep (SPEC 228).
 *
 * A count taken off one screen is a count of the WINDOW, not of the session. This scrolls the whole
 * transcript and collects the turns by uuid, so "how many of these are there" means what it meant
 * before the transcript was windowed. It finishes at the end, where a session opens, so whatever
 * runs next sees the ordinary resting state.
 */
export async function collect(page, selector, steps = 20) {
  const seen = new Set();
  const gather = async () => {
    const ids = await page.evaluate(
      (sel) => [...document.querySelectorAll(sel)].map((node) => node.closest("[data-uuid]")?.dataset.uuid ?? ""),
      selector,
    );
    for (const id of ids) if (id.length > 0) seen.add(id);
  };
  for (let i = 0; i <= steps; i += 1) {
    await page.evaluate((fraction) => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = Math.round(body.scrollHeight * fraction);
    }, i / steps);
    await page.waitForTimeout(100);
    await gather();
  }
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(150);
  await gather();
  return seen;
}

/**
 * Bring something into the middle of the transcript and click it THERE.
 *
 * `locator.click()` scrolls its target into view first, and under a windowed transcript a scroll can
 * be a redraw (SPEC 228) — so Playwright scrolls, the window remounts, the node it resolved is
 * replaced, and it starts over until the test times out. A reader never scrolls before clicking;
 * they click what is in front of them, which is what this does.
 */
export async function actOn(page, target, how = "click") {
  const at = await bring(page, target);
  if (at === null) return false;
  if (how === "tap") await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
  return true;
}

/**
 * Several selectors gathered in ONE sweep.
 *
 * Sweeping is the expensive thing a windowed transcript asks of a spec (SPEC 228), and a spec that
 * wants three counts wants them about the same session — so it walks the transcript once and
 * collects all of them, instead of three walks that also happen to disagree if a row loads late.
 */
export async function collectMany(page, selectors, steps = 16) {
  const seen = new Map(selectors.map((sel) => [sel, new Set()]));
  const gather = async () => {
    const found = await page.evaluate(
      (list) =>
        list.map((sel) => [...document.querySelectorAll(sel)].map((node) => node.closest("[data-uuid]")?.dataset.uuid ?? "")),
      selectors,
    );
    selectors.forEach((sel, i) => {
      for (const id of found[i]) if (id.length > 0) seen.get(sel).add(id);
    });
  };
  for (let i = 0; i <= steps; i += 1) {
    await page.evaluate((fraction) => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = Math.round(body.scrollHeight * fraction);
    }, i / steps);
    await page.waitForTimeout(90);
    await gather();
  }
  await page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(150);
  await gather();
  return seen;
}
