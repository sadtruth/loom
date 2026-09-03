/**
 * The queued echo, driven where it actually goes wrong (SPEC 138).
 *
 * The echo itself has been pinned since journey2-input: a mid-turn send is accepted and draws a pale
 * turn immediately. What was NOT pinned is where that turn sits and how long the client's knowledge
 * of it lives, and both were broken (User, 2026-08-10: *"it's shown not at the place i sent it but
 * below eveything and when you reload the page it dissapears altogether, though you clearly receive
 * it and react to it"*).
 *
 * So this spec drives the two facts a counter cannot show:
 *
 *   1. POSITION — a message that lands AFTER the send renders BELOW the echo. The old client appended
 *      every echo as the transcript's last child on every redraw, so anything the running turn
 *      produced afterwards went above it and the thing sent last read as the thing sent first.
 *   2. SURVIVAL — a reload mid-queue still shows it. The list was the client's own and died with the
 *      page, while the child went on holding and answering the message.
 *
 * The landing row is appended by the RUNNER, not by the stub: a real turn writes into the transcript
 * for as long as it works, and this is the only way to put a row in the file at a chosen moment while
 * the queue is provably still holding something. Its own fixture project for the same reason
 * journey12-scroll has one — appending to a shared fixture moves other specs' assertions.
 */

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const LOOM_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const QUEUE_CWD = join(LOOM_ROOT, "tests", "fixture");
const PROJECT_KEY = QUEUE_CWD.replace(/[^A-Za-z0-9-]/g, "-");
const SESSION = "00000000-fixture-0000-000000000007";
const STORE = process.env["LOOM_FIXTURE_OUT"] ?? join(LOOM_ROOT, "tests", "fixture", "projects");
const FILE = join(STORE, PROJECT_KEY, `${SESSION}.jsonl`);

const BEFORE = "queue pin: this row landed BEFORE the send";
const LANDED = "queue pin: this row landed AFTER the send";

/** A row written into the transcript at THIS moment — a reply arriving while the queue waits. */
function landRow(n, text = LANDED) {
  appendFileSync(
    FILE,
    `${JSON.stringify({
      type: "assistant",
      uuid: `77777777-0000-0000-0000-10000000000${n}`,
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: SESSION,
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
    })}\n`,
  );
}

/**
 * Where the echo sits among the drawn turns. Read as indices rather than as pixels: the complaint is
 * about ORDER, and a card's height depends on its content.
 */
async function order(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("#transcript-body .msg")];
    return nodes.map((node) => ({
      pending: node.classList.contains("pending"),
      text: (node.textContent ?? "").slice(0, 400),
    }));
  });
}

test("queue: the echo stays where it was sent, and a reload still shows it", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource.*\b(403|404|413|415)\b/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });

  await page.goto(`/?project=${PROJECT_KEY}&session=${SESSION}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator("#transcript-body")).toContainText("queue fixture: ready");

  // A slow turn holds the queue open for ~6s — long enough for everything below.
  const composer = page.locator("#composer-text");
  await composer.fill("slow one holding the turn");
  await composer.press("Enter");
  await expect(page.locator("#composer-stop"), "a turn is really running").toBeVisible({ timeout: 10_000 });

  // The turn writes BEFORE the send, which is what a working turn does for minutes on end and what
  // makes the placement rule bite: the running turn's reply is one group of rows that started before
  // the message was sent, so a rule that places an echo by its GROUP puts it after the whole thing —
  // and further down with every row that lands. The echo has to split that group where it was sent
  // (SPEC 145; User, 2026-08-10: *"the queued message does not stick to one place in chat history
  // and keeps moving"*).
  landRow(0, BEFORE);
  await expect(page.locator("#transcript-body")).toContainText(BEFORE, { timeout: 20_000 });

  await composer.fill("the queued one");
  await composer.press("Enter");
  const echo = page.locator(".msg.pending", { hasText: "the queued one" });
  await expect(echo, "the accepted message shows at once").toHaveCount(1);

  // ── 1. position ── a row that lands now belongs BELOW it, because it happened after.
  landRow(1);
  await expect(page.locator("#transcript-body")).toContainText(LANDED, { timeout: 20_000 });
  const drawn = await order(page);
  const echoAt = drawn.findIndex((m) => m.pending && m.text.includes("the queued one"));
  const landedAt = drawn.findIndex((m) => !m.pending && m.text.includes(LANDED));
  const beforeAt = drawn.findIndex((m) => !m.pending && m.text.includes(BEFORE));
  expect(echoAt, "the echo is on screen").toBeGreaterThanOrEqual(0);
  expect(landedAt, "so is the row that landed after it").toBeGreaterThanOrEqual(0);
  expect(echoAt, `the echo stays above what arrived later (order: ${JSON.stringify(drawn.map((m) => m.pending))})`)
    .toBeLessThan(landedAt);
  // And below what the same turn had already written — between the halves, not after both.
  expect(beforeAt, "the half written before the send stays above it").toBeLessThan(echoAt);

  // ── 2. survival ── the queue is the server's, so a reload gets it back.
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(echo, "a reload mid-queue still shows what is waiting").toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator("#composer-state"), "and still says a turn is running").toContainText(/working|queued|·/);

  // Position survives it too — it comes from the server's accept time, not from this page's memory.
  const after = await order(page);
  const echoAgain = after.findIndex((m) => m.pending && m.text.includes("the queued one"));
  const landedAgain = after.findIndex((m) => !m.pending && m.text.includes(LANDED));
  expect(echoAgain, "the echo came back").toBeGreaterThanOrEqual(0);
  expect(echoAgain, "and came back in its place, not at the bottom").toBeLessThan(landedAgain);

  // ── and it ends ── both turns land through the read path and no ghost is left behind.
  await expect(page.locator("#transcript-body")).toContainText("stub reply: slow one holding the turn", {
    timeout: 30_000,
  });
  await expect(page.locator("#transcript-body")).toContainText("stub reply: the queued one", { timeout: 30_000 });
  await expect(page.locator(".msg.pending"), "the echo has an end").toHaveCount(0, { timeout: 15_000 });

  // ── 3. the handover ── the real row takes the echo's exact place (SPEC 145).
  // This is the half that made the message MOVE. The CLI writes a queued message into the transcript
  // when it picks it up, stamped with pickup time — after everything the turn ahead produced while it
  // waited. So the echo stood in one place for a minute and the row that replaced it appeared at the
  // bottom. The server's accept time is what holds it still, which is why it is written to disk.
  const settled = await order(page);
  const realAt = settled.findIndex((m) => !m.pending && m.text.includes("the queued one"));
  expect(realAt, "answered, and it did not move").toBe(echoAt);
  expect(settled.findIndex((m) => m.text.includes(LANDED)), "still above the row that landed after it")
    .toBeGreaterThan(realAt);

  // And that survives a reload, because the accept time is the SERVER's — a client-side memory of it
  // would have died with the page, exactly as the queue itself used to.
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator("#transcript-body")).toContainText("stub reply: the queued one", { timeout: 20_000 });
  const reloaded = await order(page);
  const reloadedAt = reloaded.findIndex((m) => m.text.includes("the queued one"));
  expect(reloadedAt, "same place after a reload").toBe(echoAt);
  // Said as an ORDER as well as an index: a page that lost the accept times draws the row in
  // transcript order, where it happens to keep its index and still slides below the rows it was
  // sent above. Only this half fails when the sidecar is not written.
  expect(reloaded.findIndex((m) => m.text.includes(BEFORE)), "the half before it, still above").toBeLessThan(
    reloadedAt,
  );
  expect(reloaded.findIndex((m) => m.text.includes(LANDED)), "the half after it, still below").toBeGreaterThan(
    reloadedAt,
  );

  expect(errors, "no page errors across the queue flow").toEqual([]);
});
