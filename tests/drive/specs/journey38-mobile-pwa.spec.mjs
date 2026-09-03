/**
 * Mobile PWA and middle swipe gestures (loom on mobile).
 *
 * Driven at 390×844 mobile viewport.
 * Verifies:
 * 1. Static manifest declaration, raster PNG icons, and mobile web app capability.
 * 2. Middle swipe gestures:
 *    - Swiping right from the middle opens the left project rail (#side).
 *    - Swiping left dismisses the open rail.
 *    - Swiping left from the middle opens the right drawer (#drawer).
 *    - Swiping right dismisses the open drawer.
 *    - Vertical scroll does not trigger horizontal panel toggles.
 */

import { expect, test } from "@playwright/test";

const PHONE = { width: 390, height: 844 };

/** Simulate a touch swipe gesture with touchstart and touchend */
async function dispatchSwipe(page, fromX, fromY, toX, toY, steps = 5) {
  await page.evaluate(
    ({ fromX, fromY, toX, toY, steps }) => {
      const target = document.querySelector("#transcript-body") || document.body;
      const touchStart = new Touch({
        identifier: Date.now(),
        target,
        clientX: fromX,
        clientY: fromY,
        pageX: fromX,
        pageY: fromY,
      });
      target.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          touches: [touchStart],
          targetTouches: [touchStart],
          changedTouches: [touchStart],
        }),
      );

      // Interpolate move
      for (let i = 1; i <= steps; i++) {
        const curX = fromX + (toX - fromX) * (i / steps);
        const curY = fromY + (toY - fromY) * (i / steps);
        const touchMove = new Touch({
          identifier: touchStart.identifier,
          target,
          clientX: curX,
          clientY: curY,
          pageX: curX,
          pageY: curY,
        });
        target.dispatchEvent(
          new TouchEvent("touchmove", {
            bubbles: true,
            cancelable: true,
            touches: [touchMove],
            targetTouches: [touchMove],
            changedTouches: [touchMove],
          }),
        );
      }

      const touchEnd = new Touch({
        identifier: touchStart.identifier,
        target,
        clientX: toX,
        clientY: toY,
        pageX: toX,
        pageY: toY,
      });
      target.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [touchEnd],
        }),
      );
    },
    { fromX, fromY, toX, toY, steps },
  );
}

test("PWA manifest, raster PNG icons and mobile meta tags are present", async ({ page, request }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // Manifest link is in head
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).not.toBeNull();
  expect(manifestHref.endsWith(".webmanifest")).toBe(true);

  // Mobile capability meta tags
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");

  // Manifest response validation (both the linked bundled asset and the /manifest.webmanifest route)
  const bundledRes = await request.get(manifestHref);
  expect(bundledRes.status()).toBe(200);
  const bundledManifest = await bundledRes.json();
  expect(bundledManifest.display).toBe("standalone");

  const manifestRes = await request.get("/manifest.webmanifest");
  expect(manifestRes.status()).toBe(200);
  const manifest = await manifestRes.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.some((i) => i.src.includes("icon-192"))).toBe(true);
  expect(manifest.icons.some((i) => i.src.includes("icon-512"))).toBe(true);

  // Raster PNG icon responses
  const icon192 = await request.get("/icon-192.png");
  expect(icon192.status()).toBe(200);
  expect(icon192.headers()["content-type"]).toBe("image/png");

  const icon512 = await request.get("/icon-512.png");
  expect(icon512.status()).toBe(200);
  expect(icon512.headers()["content-type"]).toBe("image/png");
});

test("middle swipe gestures open and close left rail and right drawer", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const layout = page.locator("#layout");
  await expect(layout).not.toHaveClass(/rail-open/);
  await expect(layout).not.toHaveClass(/drawer-open/);

  // 1. Swipe RIGHT from the middle (195 -> 310) opens the left rail
  await dispatchSwipe(page, 195, 400, 310, 400);
  await expect(layout).toHaveClass(/rail-open/);

  // 2. Swipe LEFT from the middle (200 -> 80) closes the left rail
  await dispatchSwipe(page, 200, 400, 80, 400);
  await expect(layout).not.toHaveClass(/rail-open/);

  // 3. Swipe LEFT from the middle (200 -> 80) opens the right drawer
  await dispatchSwipe(page, 200, 400, 80, 400);
  await expect(layout).toHaveClass(/drawer-open/);

  // 4. Swipe RIGHT from the middle (195 -> 310) closes the right drawer
  await dispatchSwipe(page, 195, 400, 310, 400);
  await expect(layout).not.toHaveClass(/drawer-open/);

  // 5. Vertical swipe does NOT toggle side panels
  await dispatchSwipe(page, 195, 300, 198, 480);
  await expect(layout).not.toHaveClass(/rail-open/);
  await expect(layout).not.toHaveClass(/drawer-open/);
});
