/**
 * Auth, driven from an UNAUTHENTICATED browser (SPEC §Auth, invariant 7): the shell serves, the
 * data does not, the login overlay appears instead of a dead pane, a wrong token is refused
 * visibly, and the right one sets the cookie and boots the app live.
 *
 * Named journey3- so it runs after the pinned journey (Playwright orders by file name; the input
 * spec's stub appends would otherwise reorder the projects the bare journey `goto("/")` lands on).
 */

import { expect, test } from "@playwright/test";

// Start from nothing: no cookie, so every data route must refuse.
test.use({ storageState: { cookies: [], origins: [] } });

test("auth: data is refused without the token, login sets the cookie, app boots", async ({ page }) => {
  // ── data routes refuse, the shell does not ──────────────────────
  const bare = await page.request.get("/api/projects");
  expect(bare.status(), "projects list requires the token").toBe(401);
  const file = await page.request.get("/api/file?path=/etc/hostname");
  expect(file.status(), "the file reader requires the token before the guard even looks").toBe(401);

  // ── the overlay, not a blank app ────────────────────────────────
  await page.goto("/");
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#status")).toContainText("unauthenticated");

  // ── a wrong token is refused visibly ────────────────────────────
  const wrong = await page.request.get("/login?token=not-the-token");
  expect(wrong.status()).toBe(403);

  // ── the right token, entered the way a phone would ──────────────
  await page.locator("#login-token").fill("loom-test-token");
  await page.locator("#login button").click();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();
  await expect(page.locator("#login")).toBeHidden();
});
