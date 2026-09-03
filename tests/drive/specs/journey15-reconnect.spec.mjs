/**
 * The socket comes back by itself (session-doesnt-reconnect-after-diconnect).
 *
 * User, verbatim: "when i go to sleep on laptop the session in loom stays disconnected until i
 * reload the page (though messages are still successfully sent to it, i dont see your replies
 * until reload)". The close handler was display-only — "disconnected" was a terminal state.
 *
 * A pin cannot put the laptop to sleep, so the server severs every socket on request
 * (`/api/test/drop-sockets`, NODE_ENV=test only) — the same abrupt close the network stack
 * delivers on wake. The claim is three-sided: the page says it is reconnecting, the transcript
 * stays on screen the whole time (no blank flash), and a row appended AFTER the drop arrives
 * with no reload.
 */

import { expect, test } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const store = process.env["LOOM_FIXTURE_OUT"] ?? join(root, "tests/fixture/projects");
const file = join(store, "-fixture-project", "00000000-fixture-0000-000000000001.jsonl");

const append = (text, n) =>
  appendFileSync(
    file,
    `${JSON.stringify({
      type: "assistant",
      // NOT `dddddddd-…`: journey12-scroll's docked-append case writes exactly those uuids into this
      // same fixture, and a uuid is the identity of a message (SPEC 230) — so the second spec's row
      // was collapsed into the first spec's and never reached the screen. It failed as "the append
      // never arrived", which is a very long way from "two specs chose the same id" (2026-08-23).
      uuid: `15150000-0000-0000-0000-00000000000${n}`,
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: "00000000-fixture-0000-000000000001",
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
    })}\n`,
  );

const drop = (page) =>
  page.evaluate(async () => {
    const res = await fetch("/api/test/drop-sockets", { method: "POST" });
    return (await res.json()).dropped;
  });

test("reconnect: a severed socket comes back live, keeps the view, and catches up", async ({ page }) => {
  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  const firstMsg = page.locator(".msg").first();
  await expect(firstMsg).toBeVisible();

  // ── the sever: the page must SAY it is retrying, and must not blank the transcript ──
  expect(await drop(page), "the sever must have hit a live socket").toBeGreaterThanOrEqual(1);
  await expect(page.locator("#status")).toContainText("reconnecting", { timeout: 5_000 });
  await expect(firstMsg, "the transcript stays up while the link is down").toBeVisible();

  // ── recovery with no reload: a row written after the drop arrives on its own ──
  append("reconnect pin: written while the page thought it was offline", 1);
  await expect(page.locator("#transcript-body")).toContainText("reconnect pin: written while", {
    timeout: 20_000,
  });
  await expect(page.locator("#status")).toContainText("live");

  // ── and again, because the first recovery must not have consumed the machinery ──
  expect(await drop(page)).toBeGreaterThanOrEqual(1);
  append("reconnect pin: the second life", 2);
  await expect(page.locator("#transcript-body")).toContainText("reconnect pin: the second life", {
    timeout: 20_000,
  });
  await expect(page.locator("#status")).toContainText("live");
});

/**
 * `GET /api/session-state` answers the Runner's live truth for one session, independent of any
 * socket (session-truth step 6, parent item 64). Before this there was no such route at all —
 * confirmed by search in the design plan, zero hits for `/api/job`/`liveChildren`/`runner.list` in
 * `server/main.ts` — so this is shown RED simply by the route not existing yet.
 *
 * Queried over the SAME open socket, deliberately never severed: a browser reattach already sends a
 * fresh `job` frame with this exact truth on every WS open (`server/main.ts`'s `websocket.open`
 * handler calls `runner.running(id)` unconditionally), which is what actually closes the "spinner
 * stuck after a retire" case end-to-end once step 5 lands — found empirically while building this
 * pin (see the Log). This test isolates the ENDPOINT's own contract from that reattach path, so it
 * still fails if the route is missing or wrong even when nothing ever reconnects.
 */
const LOOM_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const PROJECT_KEY = LOOM_ROOT.replace(/[^A-Za-z0-9-]/g, "-");

async function sessionState(page, id) {
  return page.evaluate(
    async (sid) => (await fetch(`/api/session-state?session=${encodeURIComponent(sid)}`)).json(),
    id,
  );
}

test("GET /api/session-state reports running, then idle after a retire — no socket involved", async ({ page }) => {
  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composer = page.locator("#composer-text");
  await composer.fill("slow");
  await composer.press("Enter");
  await expect(page.locator("#composer-spin")).toBeVisible({ timeout: 10_000 });

  const sessionId = new URL(page.url()).searchParams.get("session");
  expect(typeof sessionId, "the sent turn adopted a session id into the URL").toBe("string");

  const running = await sessionState(page, sessionId);
  expect(running.state).toBe("running");
  expect(running.queued).toBe(1);

  const retired = await page.evaluate(
    async (id) => (await fetch(`/api/test/retire?session=${encodeURIComponent(id)}`, { method: "POST" })).ok,
    sessionId,
  );
  expect(retired).toBe(true);

  // No sever, no reconnect — the socket the composer is still using never moved. The ONLY way this
  // can read "idle" is the endpoint asking the Runner directly.
  const idle = await sessionState(page, sessionId);
  expect(idle.state).toBe("idle");
  expect(idle.queued).toBe(0);
});

/**
 * A retire while the socket is severed clears the spinner instead of leaving it stuck. Kept as a
 * regression pin for the user-visible experience item 64 is actually about, even though — per the
 * finding above — the existing WS reattach already carries this on its own once step 5 lands; the
 * client's `/api/session-state` call on reconnect (added for step 6) is defensive on top of it, not
 * the thing this particular case is shown to depend on.
 *
 * `/api/test/retire` (NODE_ENV=test only, same gate as `/api/test/drop-sockets`) reproduces the
 * retirement itself, since contriving one of the four real triggers (a model change, a dead pipe,
 * eviction, `shutdown()`) through the UI while the socket is deliberately down is not the thing this
 * pin is about — that machinery is `tests/props/retire.test.ts`'s job.
 */
test("reconnect: a retire while severed clears the spinner, not stuck on a process that no longer exists", async ({
  page,
}) => {
  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composer = page.locator("#composer-text");
  await composer.fill("slow");
  await composer.press("Enter");
  await expect(page.locator("#composer-spin")).toBeVisible({ timeout: 10_000 });

  const sessionId = new URL(page.url()).searchParams.get("session");
  expect(typeof sessionId, "the sent turn adopted a session id into the URL").toBe("string");

  // ── sever, THEN retire — the terminal event has nowhere to go ──
  expect(await drop(page)).toBeGreaterThanOrEqual(1);
  await expect(page.locator("#status")).toContainText("reconnecting", { timeout: 5_000 });
  const retired = await page.evaluate(
    async (id) => (await fetch(`/api/test/retire?session=${encodeURIComponent(id)}`, { method: "POST" })).ok,
    sessionId,
  );
  expect(retired).toBe(true);

  // Still severed: the spinner has had no way to hear about it yet.
  await expect(page.locator("#composer-spin")).toBeVisible();

  // ── reconnect, forced rather than waited out on backoff ──
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#status")).toContainText("live", { timeout: 10_000 });
  await expect(page.locator("#composer-spin")).toBeHidden({ timeout: 5_000 });
});
