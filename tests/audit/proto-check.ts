/**
 * Drive the link-fixes prototype, because a prototype nobody clicked is a drawing with a bug in it.
 * Not part of any gate — run by hand when the prototype changes.
 */

import { existsSync } from "node:fs";
import { chromium } from "playwright";

const CHROMIUM = process.env["PIN_CHROMIUM"] ?? "/run/current-system/sw/bin/chromium";
const FILE = process.argv[2];
if (FILE === undefined) throw new Error("usage: proto-check.ts <prototype.html>");

const browser = await chromium.launch(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : { args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=256", "--renderer-process-limit=2", "--no-zygote"] });
const cleanup = () => { browser.close().catch(() => {}); process.exit(1); };
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
try {
const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(`file://${FILE}`, { waitUntil: "load" });

const steps: Array<[string, string, string]> = [
  ["case 1 — the prototype chip", "#proto-pane", "iframe"],
  ["case 2 — the line chip", "#line-pane", ".md .hit"],
  ["case 3 — the glued suffix", "#glued-pane", ".pane-head"],
];

for (const [what, pane, want] of steps) {
  const chip = page.locator(`${pane}`).locator("xpath=preceding-sibling::div[@class='chat'][1]").locator(".chip");
  await chip.first().click();
  const found = await page.locator(`${pane} ${want}`).count();
  console.log(`${found > 0 ? "ok  " : "FAIL"} ${what} → ${want} ${found > 0 ? "appeared" : "MISSING"}`);
  if (found === 0) process.exitCode = 1;
}

// The switches are the whole design question — press each one.
await page.locator("#proto-pane .toggle button", { hasText: "source" }).click();
console.log(`${(await page.locator("#proto-pane pre").count()) > 0 ? "ok  " : "FAIL"} case 1 — source switch`);
await page.locator("#line-pane .toggle button", { hasText: "B ·" }).click();
console.log(`${(await page.locator("#line-pane pre .hit").count()) > 0 ? "ok  " : "FAIL"} case 2 — option B`);

const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log(`${wide ? "FAIL" : "ok  "} nothing overflows at 320px`);
if (wide) process.exitCode = 1;

if (errors.length > 0) {
  console.log(`FAIL ${errors.length} console/page errors:`);
  for (const e of errors) console.log(`  ${e}`);
  process.exitCode = 1;
} else {
  console.log("ok   no page errors");
}

} finally { await browser.close(); }
