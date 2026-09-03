import { chromium } from "playwright";
import { existsSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/loom-shot.png";
const URL = process.argv[3] ?? "http://localhost:4183/";

// Same two environment facts as tests/playwright.config.mjs: NixOS cannot run the downloaded
// browser, and the exported proxy must not swallow loopback.
const CHROMIUM = process.env["PIN_CHROMIUM"] || "/run/current-system/sw/bin/chromium";
const browser = await chromium.launch({
  ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}),
  args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=256", "--renderer-process-limit=2", "--no-zygote", "--no-proxy-server", "--proxy-bypass-list=<-loopback>"],
});
const cleanup = () => { browser.close().catch(() => {}); process.exit(1); };
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
try {
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(URL);
await page.waitForSelector("#status.live", { timeout: 20000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT });

// A second shot: document view, mid-transcript. The #view-doc button is gone (SPEC 252) — the
// document view is still just `loom-view` in localStorage, so write it and reload instead of
// clicking a button that no longer exists.
await page.evaluate(() => {
  localStorage.setItem("loom-view", JSON.stringify({ doc: true, thinking: false, meta: false, full: false }));
});
await page.reload();
await page.waitForSelector("#status.live", { timeout: 20000 });
await page.waitForTimeout(400);
const msgs = page.locator(".msg");
const n = await msgs.count();
if (n > 4) await msgs.nth(Math.floor(n / 2)).scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: OUT.replace(/\.png$/, "-doc.png") });

console.log(`messages: ${n}`);
console.log(`artifacts: ${await page.locator("#drawer-body .art").count()}`);
console.log(`rail: ${await page.locator(".rail-item").count()}`);
console.log(`chips: ${await page.locator(".chip").count()}`);
} finally { await browser.close(); }
