/**
 * The input path, driven end to end against the stub binary (LOOM_CLAUDE_BIN → tests/stub-claude.ts):
 * type → send → the reply arrives THROUGH THE READ PATH (the stub appends to the transcript file,
 * the tailer sees it, the append frame renders it) — which is the input path's whole design. Then
 * the permit loop: the stub asks like the real hook would, the card renders, Allow answers it, and
 * the verdict lands back in the transcript.
 *
 * The REAL binary's side of the contract is pinned by the spikes (DECISIONS.md 2026-08-05):
 * headless round-trip, --resume appending to the same file, hook-carried permissions.
 */

import { expect, test } from "@playwright/test";
import { unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Same rule as escapeCwd in server/input.ts — inlined because .mjs cannot import the .ts. */
const LOOM_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const PROJECT_KEY = LOOM_ROOT.replace(/[^A-Za-z0-9-]/g, "-");

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

test("input: send a message, get the reply through the read path, answer a permit", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  // ── plain send: reply must arrive via the tailer, not via the POST's response ──
  // The default permission style is AUTO (SPEC 42) — asserted on the wire, not on the checkbox.
  const composer = page.locator("#composer-text");
  const autoSend = page.waitForRequest((r) => r.url().includes("/api/input") && r.method() === "POST");
  await composer.fill("hello stub");
  await composer.press("Enter");
  expect((await autoSend).postDataJSON().mode).toBe("auto");
  await expect(page.locator("#transcript-body")).toContainText("stub reply: hello stub", { timeout: 15_000 });
  // The composer cleared and came back sendable — the job cycle completed.
  await expect(composer).toHaveValue("");
  await expect(page.locator("#composer-send")).toBeEnabled({ timeout: 10_000 });

  // ── the composer comes back down (composer record, item 1) ──
  // Growing is half the behaviour; the half that was missing is the return. The inline height
  // written while typing survived the send, so the box stayed as tall as the message already gone.
  // Measured in pixels rather than asserted on the value, because clearing the text was never the
  // broken part.
  const restHeight = (await composer.boundingBox()).height;
  await composer.fill("a long one ".repeat(120)); // one line that WRAPS — the rest of this spec
  const grownHeight = (await composer.boundingBox()).height; // reads `.msg.pending` by text.
  expect(grownHeight, "the composer grows with its content").toBeGreaterThan(restHeight + 40);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  expect((await composer.boundingBox()).height, "and comes back down on send").toBe(restHeight);
  await expect(page.locator("#transcript-body")).toContainText("stub reply: a long one", { timeout: 15_000 });
  await expect(page.locator(".msg.pending"), "the ghost is gone before the next send").toHaveCount(0);

  // ── model + thinking level: the pick has to reach the CHILD (SPEC 49) ──
  // Two assertions per send, and the second is the load-bearing one: the POST body only proves the
  // client asked, the transcript line proves the flags were actually spawned with.
  expect((await autoSend).postDataJSON().model, "an untouched picker sends default").toBe("default");
  await expect(page.locator("#transcript-body")).toContainText("[model=- effort=- mcp=on]", { timeout: 15_000 });

  await page.locator("#pick-model").selectOption("haiku");
  await page.locator("#pick-effort").selectOption("xhigh");
  // The pick reads as chosen rather than as the quiet default.
  await expect(page.locator("#pick-model")).toHaveAttribute("data-picked", "haiku");
  const pickedSend = page.waitForRequest((r) => r.url().includes("/api/input") && r.method() === "POST");
  await composer.fill("with a picked model");
  await composer.press("Enter");
  const pickedBody = (await pickedSend).postDataJSON();
  expect(pickedBody.model).toBe("haiku");
  expect(pickedBody.effort).toBe("xhigh");
  await expect(page.locator("#transcript-body")).toContainText("[model=haiku effort=xhigh mcp=on]", {
    timeout: 15_000,
  });

  // ── the browser switch: the checkbox still travels, and the browsers are on either way ──
  // It used to be two-sided — `mcp=off` until the box was ticked. Since 2026-09-01 the Playwright
  // servers are always on and `req.browser` reaches neither `childArgs` nor the fingerprint
  // (input.ts, and the unit test that pins it), so the only client-side claim left to make is that
  // the checkbox reaches the POST. `mcp=on` here says what it says everywhere else in this spec:
  // the child was handed an MCP config.
  const browserSend = page.waitForRequest((r) => r.url().includes("/api/input") && r.method() === "POST");
  await page.locator("#use-browser").check();
  await composer.fill("with a browser");
  await composer.press("Enter");
  expect((await browserSend).postDataJSON().browser, "the checkbox reaches the POST").toBe(true);
  await expect(page.locator("#transcript-body")).toContainText("[model=haiku effort=xhigh mcp=on]", {
    timeout: 15_000,
  });
  await page.locator("#use-browser").uncheck();

  // Back to default: the flags must DISAPPEAR from the spawn, not linger from the last turn.
  await page.locator("#pick-model").selectOption("default");
  await page.locator("#pick-effort").selectOption("default");
  await expect(page.locator("#pick-model")).not.toHaveAttribute("data-picked", /.*/);
  await composer.fill("back to the default model");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText(
    "stub reply: back to the default model [model=- effort=- mcp=on]",
    { timeout: 15_000 },
  );

  // The pick belongs to the SESSION now (SPEC 277), not to the device, so what survives a reload is
  // what the session was last RUN with — a pick chosen and never sent is not yet the session's.
  // This read `default` after the reload when the spec still assumed the old per-device store.
  await page.locator("#pick-model").selectOption("sonnet");
  await composer.fill("a turn with the sonnet pick");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub reply: a turn with the sonnet pick", {
    timeout: 15_000,
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator("#pick-model")).toHaveValue("sonnet");
  await expect(page.locator("#pick-model")).toHaveAttribute("data-picked", "sonnet");
  await page.locator("#pick-model").selectOption("default");
  // Still usable after the reload — the transcript came back with it.
  await expect(page.locator(".msg").first()).toBeVisible();

  // ── queue a message MID-TURN, then stop a turn (SPEC 106) ──────────
  // The reason the persistent-child rewrite exists, driven: sending is not locked while a turn
  // runs, and a turn you can see going wrong can be cut short without losing the session.
  // `[hold]` — the stub does not end this turn until the line below releases it (loom item 58).
  // It used to be a "slow" turn, six seconds of wall clock, and the queue-depth assertion under it
  // was really a bet that the machine would not be busy: it failed a land on 2026-08-19 and again
  // on 2026-08-24, passing solo both times. The clock is gone; the phases are driven from here.
  await composer.fill("[hold] this one is slow on purpose");
  await composer.press("Enter");
  await expect(page.locator("#composer-stop"), "stop appears while a turn runs").toBeVisible();

  // Typing a follow-up mid-turn must be ACCEPTED — the old shape answered 409 here.
  const queuedSend = page.waitForResponse((r) => r.url().includes("/api/input") && r.request().method() === "POST");
  await composer.fill("queued behind the slow one");
  await composer.press("Enter");
  const queuedResponse = await queuedSend;
  expect(queuedResponse.status(), "a mid-turn send is accepted, not refused as busy").toBe(200);
  expect((await queuedResponse.json()).queued, "the server reports it as queued").toBeGreaterThan(1);
  // The running state moved out of the placeholder and onto its own line (2026-08-06): a
  // placeholder disappears the moment you type, which is exactly when you want to see the queue.
  await expect(page.locator("#composer-state")).toContainText(/queued/);
  // And the message itself shows immediately, instead of only a counter going up.
  // Addressed by its TEXT, not as "the pending message": two can be pending at once — the slow one
  // and the one queued behind it — which is the very state this passage drives. The bare locator
  // passed only while the first cleared before the second arrived, and tripped strict mode on a
  // loaded machine, failing a land for a reason nobody had changed (2026-08-14).
  await expect(page.locator(".msg.pending", { hasText: "queued behind the slow one" })).toBeVisible();

  // Release the held turn. Everything above was asserted while it was CERTAINLY still running.
  writeFileSync(process.env["LOOM_STUB_HOLD"] ?? "", "");

  // Both land, in order, through the read path.
  await expect(page.locator("#transcript-body")).toContainText("stub reply: [hold] this one is slow on purpose", {
    timeout: 30_000,
  });
  await expect(page.locator("#transcript-body")).toContainText("stub reply: queued behind the slow one", {
    timeout: 30_000,
  });
  await expect(page.locator("#composer-stop")).toBeHidden({ timeout: 15_000 });
  // Put the gate back, so nothing later in this file inherits a released turn.
  unlinkSync(process.env["LOOM_STUB_HOLD"] ?? "");

  // Now the stop button, on a turn in flight.
  await composer.fill("another slow one to interrupt");
  await composer.press("Enter");
  await expect(page.locator("#composer-stop")).toBeVisible({ timeout: 15_000 });
  await page.locator("#composer-stop").click();
  await expect(page.locator("#transcript-body")).toContainText("stub: interrupted", { timeout: 20_000 });

  // The session survives its own interruption — the next message still works.
  await expect(page.locator("#composer-stop")).toBeHidden({ timeout: 15_000 });
  await composer.fill("still alive after the stop");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub reply: still alive after the stop", {
    timeout: 20_000,
  });

  // ── the permit loop, in cards mode via the toggle ─────────────────
  await page.locator("#mode-cards").check();
  const cardsSend = page.waitForRequest((r) => r.url().includes("/api/input") && r.method() === "POST");
  await composer.fill("please ask permission before writing");
  await composer.press("Enter");
  expect((await cardsSend).postDataJSON().mode).toBe("cards");
  const card = page.locator(".permit");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Write");
  await expect(card).toContainText("stub-target.txt");
  // In the FLOW now (SPEC 185), not in a fixed strip between the scroller and a bar that no longer
  // sits there: the card is inside the scrolling transcript, in message order, which is what makes
  // 184's badge necessary. Rewritten rather than inherited — the old assertions passed on a card
  // that could never scroll away.
  const placed = await card.evaluate((node) => {
    const body = document.querySelector("#transcript-body");
    const composer = document.querySelector("#composer");
    return {
      inScroller: body.contains(node),
      aboveTheComposer: node.compareDocumentPosition(composer) === Node.DOCUMENT_POSITION_FOLLOWING,
      scrolls: body.scrollHeight > body.clientHeight,
    };
  });
  expect(placed.inScroller, "the card renders inside the transcript").toBe(true);
  expect(placed.aboveTheComposer, "in message order, above the composer").toBe(true);

  // ── it can scroll away, so something must say it is waiting (SPEC 184) ──
  // The badge appears only while the card is off screen, and answers nothing itself.
  await expect(page.locator("#permit-badge")).toBeHidden();
  if (placed.scrolls) {
    await page.evaluate(() => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = 0;
    });
    await page.waitForTimeout(150);
    await expect(page.locator("#permit-badge"), "a card off screen is announced").toBeVisible();
    // ONE card's identity, not a count (object 7). "2 permissions waiting" reads the same whichever
    // card the badge scrolls to, so a second card arriving would change the badge without saying the
    // thing it points at is still the first one — the silent steal scenario 5 forbids.
    await expect(page.locator("#permit-badge"), "the badge names the card it points at").toContainText("Write");
    await expect(page.locator("#permit-badge"), "and does not count them instead").not.toContainText("waiting");
    await expect(page.locator("#permit-badge .permit-btn"), "and never answerable from there").toHaveCount(0);
    await page.locator("#permit-badge").click();
    await page.waitForTimeout(200);
    await expect(page.locator("#permit-badge"), "clicking it lands on the card, and the badge goes").toBeHidden();
  }

  // ── MESSAGE ORDER, not merely "somewhere in the scroller" (SPEC 185) ──
  // "Inside the transcript, above the composer" was true of the old shape too: it appended one
  // `#permits` container at the tail of the flow, after every message and every echo, which puts a
  // card asked mid-turn below turns that came after it. Two checks that the old shape fails.
  //
  // First: there is no container. Each card is its own child of the scroller, so nothing can hold
  // two cards asked at different points together at one position.
  await expect(page.locator("#permits"), "the container is gone, not merely moved").toHaveCount(0);
  expect(
    await card.evaluate((node) => node.parentElement.id),
    "the card is a child of the scroller itself",
  ).toBe("transcript-body");

  // Second, and this is the one with teeth: something NEWER than the card. A follow-up sent while
  // the card is up is accepted (SPEC 106) and draws its echo by accept time, so the card — asked
  // before it — must render ABOVE it. The tail container rendered below it.
  await composer.fill("queued behind the card");
  await composer.press("Enter");
  const behind = page.locator(".msg.pending", { hasText: "queued behind the card" });
  await expect(behind).toHaveCount(1);
  // THE ECHO THIS TEST MEANS, handed in, rather than whichever `.msg.pending` is first in the
  // document. The turn the card belongs to has its own echo on screen, so `querySelector` could
  // compare the card against a message sent BEFORE it and pass or fail for a reason this case is
  // not about. What is being pinned is the ORDER of two known nodes; both of them should be named.
  const order = await card.evaluate(
    (node, echo) => node.compareDocumentPosition(echo) === Node.DOCUMENT_POSITION_FOLLOWING,
    await behind.elementHandle(),
  );
  expect(order, "a card asked before the follow-up renders above it").toBe(true);

  await card.locator(".permit-btn.allow").click();
  // The verdict travelled hook → broker → stub → transcript → tailer → screen.
  await expect(page.locator("#transcript-body")).toContainText("stub verdict: allow", { timeout: 15_000 });
  await expect(card).toHaveCount(0);
  // And the follow-up that was waiting behind the card runs once the turn it blocked is over.
  await expect(page.locator("#transcript-body")).toContainText("stub reply: queued behind the card", {
    timeout: 30_000,
  });

  // ── a second send while idle still works; deny path ───────────────
  await composer.fill("please ask permission again");
  await composer.press("Enter");
  await expect(page.locator(".permit")).toBeVisible({ timeout: 15_000 });
  await page.locator(".permit-btn.deny").click();
  await expect(page.locator("#transcript-body")).toContainText("stub verdict: deny", { timeout: 15_000 });
  await page.locator("#mode-cards").uncheck();

  // ── attach an image: thumbnail strip, then the stub sees it ───────
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator("#attach-input").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(page.locator(".attach-chip img")).toHaveCount(1);
  await composer.fill("here is a picture");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("[saw 1 image]", { timeout: 15_000 });
  // The image block itself renders inline, and the strip cleared on send.
  await expect(page.locator(".msg-image").first()).toBeVisible();
  await expect(page.locator(".attach-chip")).toHaveCount(0);

  // ── start a NEW session from the stream row (SPEC 60, SPEC 278) ────
  // `+ new` was a rail button in August, then the last option of one flat session select, and is
  // now the `+` on the Claude stream row — the one select became two, one per family, so there is
  // no single list left to hold a `__new__` option. The flow still runs end to end through it.
  const picker = page.locator("#select-claude");
  await expect(page.locator("#row-claude"), "the Claude stream is the one we are in").toHaveClass(/active/);
  const before = await picker.locator("option").count();
  const previous = await picker.inputValue();
  await page.locator("#add-claude").click();
  await expect(page.locator("#status")).toContainText("new session");
  await expect(picker, "the picker says you are composing a fresh one").toHaveValue("__pending__");
  await composer.fill("first message of a fresh session");
  await composer.press("Enter");
  // The stub writes the new transcript; loom adopts it: the picker grows and lands on the new one.
  await expect(page.locator("#status")).toContainText("live", { timeout: 25_000 });
  await expect(page.locator("#transcript-body")).toContainText("stub reply: first message of a fresh session", {
    timeout: 15_000,
  });
  expect(await picker.locator("option").count(), "the picker gained a session").toBe(before + 1);
  const adopted = await picker.inputValue();
  expect(adopted, "the new session is the selected one").not.toBe(previous);
  await expect(picker.locator("option:checked")).toContainText("first message");
  expect(page.url(), "the URL followed the pick").toContain(adopted);

  // ── and an OLDER session is one pick away, transcript and URL both ─
  await picker.selectOption(previous);
  await expect(page.locator("#transcript-body")).toContainText("hello stub", { timeout: 15_000 });
  await expect(page.locator("#transcript-body")).not.toContainText("first message of a fresh session");
  expect(page.url(), "the URL carries the session you picked").toContain(previous);

  // ── the queued echo belongs to ONE session (steering item 6) ───────
  // The ghost was drawn from a flat list, so a message queued here drew pale in every other chat
  // too — and there, nothing ever arrived to prune it, so it stayed forever. Driven across a real
  // session switch while the turn is still in flight.
  // `[hold]` keeps the first turn in flight without wall-clock sleeps: only a message still waiting
  // in the queue has an echo at all.
  await composer.fill("[hold] one holding the turn");
  await composer.press("Enter");
  await expect(page.locator("#composer-stop"), "stop appears while a turn runs").toBeVisible();
  await composer.fill("queued in the older session");
  await composer.press("Enter");
  const ghost = page.locator(".msg.pending", { hasText: "queued in the older session" });
  await expect(ghost).toHaveCount(1);
  await picker.selectOption(adopted);
  await expect(page.locator("#transcript-body")).toContainText("first message of a fresh session", {
    timeout: 15_000,
  });
  await expect(page.locator(".msg.pending"), "another session's queued message is not drawn here").toHaveCount(0);
  // Back where it was sent it is still there — scoped, not merely hidden everywhere.
  await picker.selectOption(previous);
  await expect(page.locator("#transcript-body")).toContainText("hello stub", { timeout: 15_000 });
  await expect(ghost, "and it is still shown in its own session").toHaveCount(1);
  // Release the held turn. Everything above was asserted while it was CERTAINLY still running.
  writeFileSync(process.env["LOOM_STUB_HOLD"] ?? "", "");
  // And it clears there when the real turn lands — the echo has an end, in its own chat.
  await expect(page.locator("#transcript-body")).toContainText("stub reply: queued in the older session", {
    timeout: 40_000,
  });
  await expect(page.locator(".msg.pending")).toHaveCount(0);
  await expect(page.locator("#composer-stop")).toBeHidden({ timeout: 15_000 });
  // Put the gate back, so nothing later inherits a released turn.
  unlinkSync(process.env["LOOM_STUB_HOLD"] ?? "");

  expect(errors, "no page errors across the whole input flow").toEqual([]);
});

/**
 * What the READER has unfolded survives what the SESSION is doing (SPEC 146).
 *
 * User, 2026-08-10: *"when i open a list of actions you took and try to look at them, they
 * collapse back if you're doing something in the session at that point."* The transcript is a full
 * redraw per change (client/app.ts header), and a `<details>` keeps its open state nowhere but the
 * DOM — so every frame of a running turn folded the thing being read.
 *
 * Driven, not dispatched: a real turn writes real tool rows, they are opened by clicking, and then
 * a SECOND turn runs — the redraws it causes are the defect's own cause.
 */
test("an opened tool disclosure survives the redraws of a running turn", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composer = page.locator("#composer-text");
  await composer.fill("run some tools please");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub: tools done", { timeout: 20_000 });

  // The three calls folded into one strip; open it, then open one call inside it.
  const strip = page.locator("details.steps").last();
  await expect(strip).toHaveCount(1);
  await strip.locator("summary").first().click();
  const tool = strip.locator("details.tool").first();
  await expect(tool).toBeVisible();
  await tool.locator("summary").first().click();
  await expect(tool.locator("pre").first()).toBeVisible();

  // ── now a turn runs underneath the reader ──────────────────────────
  await composer.fill("slow one to redraw underneath");
  await composer.press("Enter");
  // Mid-turn: the transcript has already redrawn at least once (the user row landed).
  await expect(page.locator("#transcript-body")).toContainText("slow one to redraw underneath", {
    timeout: 15_000,
  });
  await expect(strip, "the strip is still open mid-turn").toHaveJSProperty("open", true);
  await expect(tool, "and so is the call inside it").toHaveJSProperty("open", true);

  // And when the reply lands — the redraw that carries new content is the same one.
  await expect(page.locator("#transcript-body")).toContainText("stub reply: slow one to redraw underneath", {
    timeout: 40_000,
  });
  await expect(strip, "still open once the turn finished").toHaveJSProperty("open", true);
  await expect(tool).toHaveJSProperty("open", true);
  await expect(tool.locator("pre").first()).toBeVisible();

  // Two-sided: a disclosure nobody opened is still CLOSED. Without this, "never fold" would pass.
  await composer.fill("run some tools please, again");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub: tools done", { timeout: 20_000 });
  await expect(page.locator("details.steps").last(), "a fresh strip arrives folded").toHaveJSProperty(
    "open",
    false,
  );

  expect(errors, "no page errors while reading through a running turn").toEqual([]);
});
