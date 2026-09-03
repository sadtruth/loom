/**
 * P1 — the driven user journey. VERIFY.md's "a narrow assertion is not a driven flow".
 *
 * This opens the loom the way User would, then USES it: lands at the end of the session, reads,
 * expands a folded run of tool calls, opens a file in the pane, filters, pins a message, switches to
 * document view. After every step it re-asserts the page is still usable — the reader bugs that
 * shipped green were all stateful drift that a one-shot assertion could not see.
 *
 * Pinned test: editing this file during a fix requires User's explicit approval, stated in chat.
 * Edited 2026-08-01 for a REQUESTED behaviour change, not a fix: a path click now opens loom's own
 * file pane instead of handing off to Obsidian, so the space/Cyrillic round-trip is asserted on the
 * pane's path line, and the hand-off is asserted through the ↗ button.
 * Edited 2026-08-06, again for a REQUESTED change and stated in chat: the session LIST became a
 * select in the tab bar, and the three view toggles moved into the wheel — so the list assertions
 * became select assertions, and every toggle click now opens the wheel first, which is itself the
 * thing worth pinning about the wheel.
 * Edited 2026-08-12, REQUESTED change, SPEC 187: the wheel is gone and the three toggles are plain
 * buttons at the foot of the right column. Every `withWheel` wrapper became a direct click, and the
 * "closed hides, open reveals, Escape shuts" block became the thing that replaced it — the toggles
 * are visible and clickable with no gesture in front of them.
 * Edited 2026-08-26, SPEC 252: the three toggle buttons themselves are gone (`#view-doc`,
 * `#t-thinking`, `#t-meta`), so the cases that only proved a BUTTON existed or looked right are
 * deleted as noise for a removed feature. `loom-view` still drives the render (114) — cases that
 * cared about the STATE it reaches (thinking blocks shown, document view) now write the key and
 * reload instead of clicking, and keep their assertions.
 */

import { expect, test } from "@playwright/test";
import { actOn, collectMany, reveal, settle } from "../reveal.mjs";

const SPACED_PATH = "/Users/user/docs/Projects/Personal Claude/tools/loom/SPEC.md";
const CYRILLIC_PATH = "/Users/user/docs/Заметки/важный файл.md";

/** Collected for the whole run; a page error at any step fails the journey. */
function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The read guard REFUSING a path is a tested behaviour, not a fault: chromium logs every non-2xx
    // fetch as a console error, and the journey deliberately clicks a path outside loom's readable
    // roots. The refusal is asserted where it belongs — as text in the pane. Everything else counts.
    if (/Failed to load resource.*\b(403|404|413|415)\b/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function stayUsable(page, errors, step) {
  // The centre shows ONE thing (SPEC 200): the transcript, or a file that stood it down. Before
  // this build a file was a column beside the chat, so the transcript was always on screen.
  if (await page.locator("#file").isVisible()) {
    await expect(page.locator("#file-body"), `${step}: the file is on screen`).toBeVisible();
  } else {
    await expect(page.locator(".msg").first(), `${step}: transcript still has messages`).toBeVisible();
  }
  const status = await page.locator("#status").textContent();
  expect(status, `${step}: status is not an error`).not.toContain("error");
  expect(errors, `${step}: no page errors`).toEqual([]);
}

test("journey: open, read, filter, expand, open a file, pin, document view", async ({ page }) => {
  const errors = watchErrors(page);

  // ── open ────────────────────────────────────────────────────────
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  const total = await page.locator(".msg").count();
  expect(total, "a real transcript rendered").toBeGreaterThan(3);
  await stayUsable(page, errors, "open");

  // ── opening lands at the END of the session ─────────────────────
  // A 188-message session that opens at the top means scrolling for a second before seeing anything
  // current. Asserted on the real consequence — the newest turn is on screen — not on a scroll number.
  const box = await page.locator("#transcript-body").evaluate((node) => ({
    top: node.scrollTop,
    height: node.scrollHeight,
    client: node.clientHeight,
  }));
  expect(box.height, "the fixture is taller than one screen").toBeGreaterThan(box.client + 200);
  expect(box.top, "did not stay at the top").toBeGreaterThan(0);
  await expect(page.locator(".msg").last(), "the newest turn is on screen").toBeInViewport();

  // The transcript is a tree of user+assistant turns, and tool-result carrier rows must NOT show up
  // as fake turns from User.
  const userTurns = await page.locator(".msg.user").count();
  expect(userTurns).toBeGreaterThan(0);
  expect(userTurns).toBeLessThan(total);

  // ── the answer of a turn is a MARK, not a treatment (SPEC 190) ───
  // Drawn on the same `stop_reason` test the tree's envelope uses (SPEC 111), so the two agree by
  // construction. v7 gave the answer a white card and dimmed the working steps around it, and he
  // rejected that in four words — so what is pinned here is as much what it must NOT be.
  // Counted over the whole SESSION, by sweeping it, because the transcript is windowed (SPEC 228)
  // and a count taken off one screen counts the window. The distinction being pinned is about turns,
  // so it has to be asked of the turns and not of whichever ones happen to be mounted.
  const swept = await collectMany(page, [".msg.assistant.answer", ".msg.assistant", ".msg.user.answer"]);
  const answered = swept.get(".msg.assistant.answer");
  const assistants = swept.get(".msg.assistant");
  const answers = page.locator(".msg.assistant.answer");
  expect(answered.size, "the finished turns are marked").toBeGreaterThan(0);
  expect(swept.get(".msg.user.answer").size, "a turn of his is not an answer").toBe(0);
  // And not every turn: a turn whose last row is a tool call has not answered anything yet, which
  // is exactly the distinction `stop_reason` makes. The fixture holds one such turn.
  expect(answered.size, "a turn that never stopped is not an answer").toBeLessThan(assistants.size);
  // The mark hangs off the element AFTER the head, because 190 aligns it to the message's first
  // LINE and the head is the who-and-time row above that line. Measured as a position, not as a
  // rule: the dot's centre and the centre of the first line box, in the same coordinates.
  const mark = await answers.first().evaluate((node) => {
    const head = node.querySelector(".msg-head");
    const firstLine = head.nextElementSibling;
    if (firstLine === null) return null;
    const dot = getComputedStyle(firstLine, "::before");
    const msg = getComputedStyle(node);
    const box = firstLine.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(firstLine);
    const line = range.getClientRects()[0];
    return {
      width: dot.width,
      height: dot.height,
      radius: dot.borderRadius,
      colour: dot.backgroundColor,
      ink: msg.color,
      background: msg.backgroundColor,
      border: msg.borderTopWidth,
      dotCentre: box.top + Number.parseFloat(dot.top),
      lineCentre: line === undefined ? null : line.top + line.height / 2,
      headCentre: head.getBoundingClientRect().top + head.getBoundingClientRect().height / 2,
    };
  });
  expect(mark, "an answer turn has something after its head to mark").not.toBeNull();
  expect(mark.width, "6px").toBe("6px");
  expect(mark.height, "6px").toBe("6px");
  expect(mark.radius, "a circle").toBe("50%");
  expect(mark.colour, "at the text colour").toBe(mark.ink);
  expect(mark.lineCentre, "the first line was measurable").not.toBeNull();
  expect(
    Math.abs(mark.dotCentre - mark.lineCentre),
    "the dot sits on the middle of the message's first line",
  ).toBeLessThanOrEqual(2);
  // And NOT on the row above it, which is where centring on the head put it.
  expect(
    Math.abs(mark.dotCentre - mark.headCentre),
    "not on the who-and-time row",
  ).toBeGreaterThan(4);
  // No card: v7's rejected treatment was a white box with a border, on a page that is not white.
  expect(mark.background, "no card").toBe("rgba(0, 0, 0, 0)");
  expect(mark.border, "no border").toBe("0px");

  // ── no measure in the centre (SPEC 183) ─────────────────────────
  // The 78ch cap was most of what made the centre feel narrow. A message now runs the column, so
  // this measures the real consequence: the text box is as wide as the space it was given.
  const runsFull = await page.locator(".msg.assistant").first().evaluate((node) => {
    const body = node.parentElement;
    const pad = getComputedStyle(body);
    const room = body.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
    return { msg: Math.round(node.getBoundingClientRect().width), room: Math.round(room) };
  });
  expect(runsFull.msg, `a message fills the column (room ${runsFull.room})`).toBe(runsFull.room);

  // ── sessions are a PICK in the tab bar, not a panel (SPEC 60, SPEC 278) ───
  // The rail spent its width on a session list; sessions are now stream rows (#select-claude,
  // #add-claude) where the picker lands on the newest session and #row-claude carries .active.
  // The rail keeps nothing but the tree.
  const picker = page.locator("#select-claude");
  await expect(picker).toBeVisible();
  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  const options = picker.locator("option");
  expect(await options.count(), "sessions in the claude stream").toBeGreaterThan(0);
  await expect(page.locator("#add-claude"), "a new session is one click away").toBeVisible();
  // Landed on the newest: the select's value is the first session the API listed (it sorts by mtime).
  const newest = await page.evaluate(async () => {
    const url = new URL(location.href).searchParams.get("project");
    const key = url ?? (await (await fetch("/api/projects")).json())[0].key;
    return (await (await fetch(`/api/projects/${key}/sessions`)).json())[0].id;
  });
  expect(await picker.inputValue(), "the newest session is where you land").toBe(newest);
  // And the rail really is reclaimed — the whole session section is GONE, not merely hidden.
  expect(await page.locator("#sessions-body").count(), "the session panel is gone").toBe(0);
  expect(await page.locator("#side-controls").count(), "the toggle row is gone").toBe(0);
  await stayUsable(page, errors, "session picker");

  // ── the wheel, and the three view toggles that replaced it, are both gone (SPEC 187, 249) ──
  // SPEC 187 put doc/thinking/meta at the foot of the right column as three plain buttons instead
  // of a wheel; SPEC 252 removes the buttons themselves — User used none of the three, and asked
  // twice for the foot to be more compact. `#view-toggles` and the per-toggle use counters it grew
  // (the wheel-era measurement) are gone with the buttons; a test for either is now noise for a
  // removed feature. `loom-view` still drives the render (114) — reaching document view or
  // thinking/meta rows is covered later in this journey by writing that key directly.
  expect(await page.locator("#wheel-hub").count(), "the wheel is gone, not merely closed").toBe(0);
  expect(await page.locator("#wheel").count(), "and so is the thing it opened").toBe(0);
  expect(await page.locator("#view-toggles").count(), "and so are the buttons SPEC 252 removed").toBe(0);
  await stayUsable(page, errors, "toggles gone");

  // ── artifacts drawer ────────────────────────────────────────────
  const artifacts = page.locator("#drawer-body .art");
  expect(await artifacts.count(), "drawer found touched files").toBeGreaterThan(0);
  await expect(page.locator("#drawer-body .art.write").first()).toBeVisible();
  await expect(page.locator("#drawer-body .art.read").first()).toBeVisible();
  await stayUsable(page, errors, "drawer");

  // ── folded runs ─────────────────────────────────────────────────
  // A run of consecutive tool calls collapses to one strip; the call that FAILED stays out of it.
  // `> summary` matters: a strip CONTAINS tool disclosures, each with its own summary.
  const strip = page.locator("details.steps").first();
  const stripSummary = strip.locator(":scope > summary");
  // The transcript is windowed (SPEC 228): a folded strip deep in the session is not a node until
  // the reader reaches it, and `scrollIntoViewIfNeeded` cannot scroll to something unbuilt.
  expect(await reveal(page, "details.steps"), "the fixture's folded strip is reachable").toBe(true);
  await settle(page);
  await expect(stripSummary).toContainText(/\d+ steps/);
  // A closed strip holds nothing at all now (SPEC 229), so there is no `details.tool` inside it to
  // be hidden — which `toBeHidden` accepts, and which is a stronger statement than it used to be.
  await expect(strip.locator("details.tool").first()).toBeHidden();
  // Clicked where it sits rather than scrolled to: a scroll is a redraw under a windowed transcript
  // (SPEC 228), and `locator.click()` scrolls first, so it fights its own target.
  expect(await actOn(page, "details.steps > summary"), "the strip's summary is clickable").toBe(true);
  await expect(strip).toHaveAttribute("open", "");
  await expect(strip.locator("details.tool").first()).toBeVisible();
  await stayUsable(page, errors, "expand step run");

  // The failing call is a sibling of the strip, never inside it.
  const failed = page.locator("details.tool.error").first();
  await expect(failed).toBeVisible();
  expect(await failed.evaluate((node) => node.closest("details.steps") === null)).toBe(true);
  await stayUsable(page, errors, "failed call is not folded");

  // ── expand a tool call ──────────────────────────────────────────
  const tool = strip.locator("details.tool").first();
  expect(await actOn(page, "details.steps details.tool > summary"), "a call inside the strip is clickable").toBe(true);
  await expect(tool).toHaveAttribute("open", "");
  await expect(tool.locator("pre").first()).toBeVisible();
  // The Bash gist survives: the label says what ran, not which directory it ran in.
  const bashSummary = await page.locator("details.tool .tsum").first().textContent();
  expect(bashSummary.startsWith("cd "), "the cd prefix is stripped from the label").toBe(false);
  await stayUsable(page, errors, "expand tool");

  // ── thinking is hidden until asked for ──────────────────────────
  // The #t-thinking button that used to reach this is gone (SPEC 252), and with it the "an ON
  // toggle looks on and does not drag its neighbour with it" assertions — there is no button left
  // to look on. What survives is the state itself: thinking blocks stay hidden until `loom-view`
  // says otherwise, and the render obeys it (114) without a click in front of it.
  await expect(page.locator("details.thinking")).toHaveCount(0);
  await page.evaluate(() => {
    localStorage.setItem(
      "loom-view",
      JSON.stringify({ doc: false, thinking: true, meta: false, full: false }),
    );
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  expect(await page.locator("details.thinking").count()).toBeGreaterThan(0);
  await page.evaluate(() => {
    localStorage.setItem(
      "loom-view",
      JSON.stringify({ doc: false, thinking: false, meta: false, full: false }),
    );
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator("details.thinking")).toHaveCount(0);
  await stayUsable(page, errors, "thinking toggle");

  // ── the link fix: a path with a SPACE and one with CYRILLIC ─────
  // A click now opens the file INSIDE loom (2026-08-01, by request), so the pane's path line is
  // where the round trip is asserted: the RAW path must arrive intact, which is precisely what
  // markdown links were mangling. Cmd-click still hands off, asserted below.
  const spacedChip = page.locator(`.chip[data-path="${SPACED_PATH}"]`).first();

  await expect(spacedChip).toBeVisible();
  expect(await actOn(page, spacedChip), "spacedChip is clickable where it sits").toBe(true);
  await expect(page.locator("#file")).toBeVisible();
  await expect(page.locator("#file-path"), "the space survived the round trip").toHaveText(SPACED_PATH);
  await stayUsable(page, errors, "chip opens the pane");

  // A file IS the centre now (SPEC 189), so the transcript — and the next chip in it — is a ROW
  // away: the chat row brings it back and the file stays open. It used to be a column beside the
  // chat, where both were on screen at once.
  await page.locator('.open-row[data-kind="session"]').click();
  const cyrillicChip = page.locator(`.chip[data-path="${CYRILLIC_PATH}"]`).first();

  expect(await actOn(page, cyrillicChip), "cyrillicChip is clickable where it sits").toBe(true);
  await expect(page.locator("#file-path"), "Cyrillic and a space survived together").toHaveText(CYRILLIC_PATH);
  // Outside loom's readable roots — the guard must SAY so rather than serve it.
  await expect(page.locator(".file-note")).toContainText("403");
  await stayUsable(page, errors, "guard refuses outside a root");

  // A relative code-span path resolves against the session cwd before being used.
  await page.locator('.open-row[data-kind="session"]').click();
  const relativeChip = page.locator('.chip[data-path="tools/loom/ARCHITECTURE.md"]').first();

  expect(await actOn(page, relativeChip), "relativeChip is clickable where it sits").toBe(true);
  const relativeShown = await page.locator("#file-path").textContent();
  expect(relativeShown).toMatch(/\/tools\/loom\/ARCHITECTURE\.md$/);
  expect(relativeShown.startsWith("/"), "relative path was absolutised").toBe(true);

  // ── a real file actually renders in the pane ────────────────────
  await page.locator('.open-row[data-kind="session"]').click();
  const realChip = page.locator('.chip[data-path$="/ARCHITECTURE.md"]').last();

  expect(await actOn(page, realChip), "realChip is clickable where it sits").toBe(true);
  await expect(page.locator(".file-md")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".file-md")).toContainText("ARCHITECTURE");
  await stayUsable(page, errors, "file pane renders markdown");

  // The hand-off is still reachable — now as the ↗ button rather than the default click.
  const opened = [];
  await page.route("**/api/open", async (route) => {
    opened.push(JSON.parse(route.request().postData() ?? "{}").path);
    await route.fulfill({ json: { ok: true, how: "obsidian", target: "test" } });
  });
  await page.locator("#file-open").click();
  await expect.poll(() => opened.length).toBe(1);
  expect(opened[0]).toMatch(/\/ARCHITECTURE\.md$/);

  // Escape closes the file AND its row — a pane closed on its own would leave a row naming
  // nothing. The set holds ONE thing beside the chat (SPEC 196), so what Escape lands on is the file
  // this one displaced: one step back, once, and then the chat. Escape's owner is settled at 187.
  const fileRows = page.locator('.open-row[data-kind="file"]');
  await expect(fileRows, "one row, the file being read").toHaveCount(1);
  const shownKey = await fileRows.getAttribute("data-key");
  await page.keyboard.press("Escape");
  await expect(fileRows, "the file it displaced came back").toHaveCount(1);
  await expect(fileRows).not.toHaveAttribute("data-key", shownKey ?? "");
  await expect(page.locator("#file"), "so the centre still holds a file").toBeVisible();
  // The displaced slot is one deep and it is spent: the next Escape has nothing to give back.
  await page.keyboard.press("Escape");
  await expect(fileRows).toHaveCount(0);
  await expect(page.locator("#file")).toBeHidden();
  await expect(page.locator("#chat-area")).toBeVisible();
  await stayUsable(page, errors, "pane closed");

  // Clicking a drawer row opens the pane too.
  await artifacts.first().click();
  await expect(page.locator("#file")).toBeVisible();
  await page.keyboard.press("Escape");
  await stayUsable(page, errors, "chips");

  // ── rich blocks ─────────────────────────────────────────────────
  await expect(page.locator(".rich-table table").first()).toBeVisible();
  await expect(page.locator(".rich-table th").first()).toHaveText("pane");
  await expect(page.locator(".rich-grid figure")).toHaveCount(2);
  await expect(page.locator(".rich-src summary").first()).toBeVisible();
  await stayUsable(page, errors, "rich blocks");

  // ── pin ─────────────────────────────────────────────────────────
  const target = page.locator(".msg.assistant").first();

  await target.hover();
  await target.locator(".pin-btn").click();
  await expect(page.locator(".msg.pinned")).toHaveCount(1);
  await stayUsable(page, errors, "pin");

  // Pin survives a reload — it is a sidecar on disk, not client state.
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg.pinned")).toHaveCount(1);
  await stayUsable(page, errors, "pin persisted");

  // Unpin, to leave the fixture as we found it.
  const pinned = page.locator(".msg.pinned").first();

  await pinned.hover();
  await pinned.locator(".pin-btn").click();
  await expect(page.locator(".msg.pinned")).toHaveCount(0);
  await stayUsable(page, errors, "unpin");

  // (The filter input was removed at User's request, 2026-08-05 — no filter step.)

  // ── document view ───────────────────────────────────────────────
  // The #view-doc button is gone (SPEC 252); `loom-view` still drives the render (114), so this
  // reaches document view by writing the key and reloading instead of clicking a button that no
  // longer exists.
  await page.evaluate(() => {
    localStorage.setItem(
      "loom-view",
      JSON.stringify({ doc: true, thinking: false, meta: false, full: false }),
    );
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator("#layout")).toHaveClass(/doc/);
  await expect(page.locator("details.steps").first()).toBeHidden();
  await expect(page.locator("details.tool.error").first()).toBeHidden();
  await expect(page.locator(".msg.assistant").first()).toBeVisible();
  await stayUsable(page, errors, "document view");

  await page.evaluate(() => {
    localStorage.setItem(
      "loom-view",
      JSON.stringify({ doc: false, thinking: false, meta: false, full: false }),
    );
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  // Asserted on the STRIP, not on `details.tool`: after folding, the first tool disclosure lives
  // inside a collapsed strip and is legitimately hidden in chat view too.
  await expect(page.locator("details.steps > summary").first()).toBeVisible();
  await stayUsable(page, errors, "back to chat");

  // ── panes collapse ──────────────────────────────────────────────
  await page.locator("#drawer-collapse").click();
  await expect(page.locator("#drawer")).toBeHidden();
  await stayUsable(page, errors, "panes collapsed");
});

test("live append: a row written while the page is open shows up", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.getByText("Пришло позже")).toHaveCount(0);

  // Append to the fixture the way Claude Code does: one JSON object, one newline, non-atomic.
  const { appendFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  // Derived from this file's location, not an env var: `bun run pins` must work with no setup.
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  // The config exports the slotted fixture root; the default keeps "no setup" true.
  const store = process.env["LOOM_FIXTURE_OUT"] ?? join(root, "tests/fixture/projects");
  const file = join(store, "-fixture-project/00000000-fixture-0000-000000000001.jsonl");

  const row = {
    type: "assistant",
    uuid: "33333333-0000-0000-0000-000000000001",
    parentUuid: null,
    timestamp: new Date().toISOString(),
    sessionId: "00000000-fixture-0000-000000000001",
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "text", text: "**Appended live.** Пришло позже." }] },
  };
  // Half first, to prove a partial line is not rendered as a phantom message (SPEC invariant 4).
  // Asserted on TEXT rather than message count: consecutive assistant rows merge into one turn, so a
  // count would be unchanged by a correct append and the assertion would prove nothing.
  const line = `${JSON.stringify(row)}\n`;
  const cut = Math.floor(line.length / 2);
  appendFileSync(file, line.slice(0, cut));
  await page.waitForTimeout(800);
  await expect(page.getByText("Пришло позже"), "half a line is not a message").toHaveCount(0);

  appendFileSync(file, line.slice(cut));
  await expect(page.getByText("Пришло позже")).toHaveCount(1, { timeout: 10_000 });
  await stayUsable(page, errors, "live append");
});
