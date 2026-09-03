// Open a real loom deep link in a real browser and report what the page ended up showing.
// Usage: bun tests/drive/link-check.mjs "<url>" [token]
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const target = process.argv[2];
const token = process.argv[3] ?? "";
const CHROMIUM = process.env["PIN_CHROMIUM"] || "/run/current-system/sw/bin/chromium";
const browser = await chromium.launch({
  ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}),
  args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=256", "--renderer-process-limit=2", "--no-zygote", "--no-proxy-server", "--proxy-bypass-list=<-loopback>"],
});
const cleanup = () => { browser.close().catch(() => {}); process.exit(1); };
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
try {
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const log = [];
page.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => log.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) log.push(`[http ${r.status()}] ${r.url()}`); });

const origin = new URL(target).origin;
if (token.length > 0) await page.goto(`${origin}/login?token=${token}`);
await page.goto(target);
await page.waitForTimeout(6000);
console.log("final url:", page.url());
console.log("status text:", (await page.locator("#status").innerText().catch(() => "?")).slice(0, 200));
console.log("messages:", await page.locator(".msg").count());
console.log("rail items:", await page.locator(".rail-item").count());
console.log("chips:", await page.locator(".chip").count());
console.log("open tabs:", await page.locator("#opens .open, .open-tab").count().catch(() => -1));
console.log("--- console ---");
for (const l of log.slice(-60)) console.log(l);
await page.screenshot({ path: "/tmp/loom-link-check.png", fullPage: false });
} finally { await browser.close(); }
