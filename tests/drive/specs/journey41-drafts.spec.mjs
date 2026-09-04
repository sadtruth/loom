import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

test("drafts survive a reload and follow across devices", async ({ browser }) => {
  // Use a persistent context for page A
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();

  await pageA.goto(FIXTURE);
  await expect(pageA.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composerA = pageA.locator("#composer-text");

  // (1) Type into composer, reload, text is back within 3s
  await composerA.fill("Draft text part 1");
  await pageA.waitForTimeout(500); // give debounce time

  await pageA.reload();
  await expect(pageA.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composerAReloaded = pageA.locator("#composer-text");
  await expect(composerAReloaded).toHaveValue("Draft text part 1", { timeout: 3000 });

  // (2) Type on page A, open page B in a NEW browser context created with the same storageState
  // Playwright handles storageState with `contextA.storageState()`, we pass it to contextB
  await composerAReloaded.fill("Draft text part 2");
  await pageA.waitForTimeout(500); // give debounce time

  const storageState = await contextA.storageState();
  const contextB = await browser.newContext({ storageState });

  // Explicitly clear local storage for context B's page since standard context creation
  // might copy it if we used standard options, but storageState only contains cookies and origins.
  // The requirement says: "so it has cookies but no localStorage"
  const pageB = await contextB.newPage();
  await pageB.goto(FIXTURE);
  await pageB.evaluate(() => localStorage.clear());
  // Need to reload to apply cleared local storage properly if scripts already read it,
  // but we cleared it right after goto... actually better to clear and then reload:
  await pageB.reload();

  await expect(pageB.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composerB = pageB.locator("#composer-text");

  // Page B's composer should show the text within 3s (fetched from server)
  await expect(composerB).toHaveValue("Draft text part 2", { timeout: 3000 });

  // (3) With A and B both open, type more on A — B follows within 3s without a reload
  await composerAReloaded.fill("Draft text part 3");
  await pageA.waitForTimeout(500); // give debounce time

  await expect(composerB).toHaveValue("Draft text part 3", { timeout: 3000 });

  // (4) Send on A (press Enter) — both composers are empty within 5s
  await composerAReloaded.press("Enter");

  await expect(composerAReloaded).toHaveValue("", { timeout: 5000 });
  await expect(composerB).toHaveValue("", { timeout: 5000 });
});
