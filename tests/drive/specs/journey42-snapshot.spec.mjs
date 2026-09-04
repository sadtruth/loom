import { expect, test } from "@playwright/test";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

test("snapshot: restores transcript before socket answers", async ({ page }) => {
  // 1. Open the session, wait for `live`
  await page.goto(FIXTURE);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // Note the `.msg` count and the last `.msg` text
  const msgs = page.locator(".msg");
  const msgCount = await msgs.count();
  expect(msgCount).toBeGreaterThan(0);
  const lastMsgText = await msgs.last().textContent();

  // Wait a bit to ensure the debounce timer (1s) fired and saved the snapshot
  await page.waitForTimeout(1500);

  // 2. Route websocket so it never delivers frames
  await page.routeWebSocket("**/ws*", () => {});

  // 3. Reload the page
  await page.reload();

  // 4. Assert `.msg` count equals the noted one within 3s while `#status` does NOT contain `live`
  await expect(async () => {
    const currentCount = await page.locator(".msg").count();
    expect(currentCount).toBe(msgCount);
  }).toPass({ timeout: 3_000 });

  const statusText = await page.locator("#status").textContent();
  expect(statusText).not.toContain("live");

  const currentLastText = await page.locator(".msg").last().textContent();
  expect(currentLastText).toBe(lastMsgText);

  // 5. Unroute all and reload
  await page.unrouteAll();
  await page.reload();

  // 6. Assert `live` and the same count
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  const finalCount = await page.locator(".msg").count();
  expect(finalCount).toBe(msgCount);
});
