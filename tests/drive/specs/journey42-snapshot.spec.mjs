import { expect, test } from "@playwright/test";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

test("snapshot: restores transcript immediately before socket arrives", async ({ page }) => {
  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const msgs = page.locator(".msg");
  const msgCount = await msgs.count();
  expect(msgCount).toBeGreaterThan(0);

  const lastMsgText = await msgs.last().textContent();

  // Route WebSocket to hang/drop frames so we can assert the snapshot is painted
  await page.routeWebSocket("**/ws*", () => {});

  await page.reload();

  // The snapshot should paint immediately, before any "live" state since WS is blocked
  await expect(msgs).toHaveCount(msgCount, { timeout: 3_000 });
  expect(await msgs.last().textContent()).toBe(lastMsgText);
  await expect(page.locator("#status")).not.toContainText("live");

  // Unblock WS, reload, and verify normal live connection succeeds
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();

  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(msgs).toHaveCount(msgCount, { timeout: 5_000 });
  expect(await msgs.last().textContent()).toBe(lastMsgText);
});
