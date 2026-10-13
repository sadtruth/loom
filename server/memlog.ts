import { heapStats } from "bun:jsc";

/**
 * The memory log (record item 97). Every LOOM_MEMORY_LOG_MS (default ten minutes) loom writes
 * one journal line: its RSS, the JS heap, and how the RSS changed while each kind of request
 * was being handled. Read it with `journalctl --user -u loom | grep 'memory:'`.
 *
 * Why it exists: `/api/memory` counts JS objects, and the growth is not in them. On 2026-10-06
 * a 1.5 GB process held 23 MB of JS heap after a full collection, and every part tried alone on
 * a copy of loom (reconnects, appends, the polled routes, child output, idle timers) gave its
 * memory back. So the open question is which work the growth FOLLOWS under real use.
 *
 * A request's share is the RSS after it minus the RSS before it. Requests overlap and the
 * collector runs when it likes, so one number means little; summed over ten minutes, the kind
 * that keeps growing stands out. "other" is the change while no tracked handler was running:
 * timers, child output, pushes to sockets.
 */

const PERIOD_MS = Number(Bun.env["LOOM_MEMORY_LOG_MS"] ?? 600_000);
const SHOWN = 6;

interface Tally {
  calls: number;
  /** Bytes of RSS change summed over the calls; negative when they gave memory back. */
  growth: number;
}

/** Since the last log line. */
const recent = new Map<string, Tally>();
/** Since the process started, for `/api/memory`. */
const total = new Map<string, Tally>();

function add(into: Map<string, Tally>, label: string, growth: number): void {
  const tally = into.get(label) ?? { calls: 0, growth: 0 };
  tally.calls += 1;
  tally.growth += growth;
  into.set(label, tally);
}

function note(label: string, before: number): void {
  const growth = process.memoryUsage.rss() - before;
  add(recent, label, growth);
  add(total, label, growth);
}

/** Runs `run` and books the RSS change under `label`, after the promise settles if it returns one. */
export function track<T>(label: string, run: () => T): T {
  const before = process.memoryUsage.rss();
  const result = run();
  if (result instanceof Promise) return result.finally(() => note(label, before)) as T;
  note(label, before);
  return result;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function wrap(label: string, handler: unknown): unknown {
  if (typeof handler !== "function") return handler;
  return (...args: unknown[]) => track(label, () => handler(...args));
}

/** Every handler in a `Bun.serve` routes table, tracked under its path pattern. Static responses
 * and HTML bundles are left alone; a per-method table gets each method tracked separately. */
export function instrumentRoutes<R>(routes: R): R {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes as Record<string, unknown>)) {
    if (typeof value === "function") {
      out[path] = wrap(path, value);
    } else if (value !== null && typeof value === "object" && !(value instanceof Response) && Object.keys(value).length > 0 && Object.keys(value).every((key) => METHODS.has(key))) {
      out[path] = Object.fromEntries(Object.entries(value).map(([method, handler]) => [method, wrap(`${method} ${path}`, handler)]));
    } else {
      out[path] = value;
    }
  }
  return out as R;
}

/** The websocket handlers, tracked as "ws open", "ws close" and so on. */
export function instrumentSocket<H>(handlers: H): H {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(handlers as Record<string, unknown>)) out[name] = wrap(`ws ${name}`, value);
  return out as H;
}

const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;
const signed = (bytes: number): string => `${bytes >= 0 ? "+" : "−"}${mb(Math.abs(bytes))}`;

function sorted(tallies: Map<string, Tally>): [string, Tally][] {
  return [...tallies].sort((a, b) => b[1].growth - a[1].growth);
}

/** The totals since start, largest growth first, for `/api/memory`. */
export function requestTotals(): Record<string, { calls: number; growthMB: number }> {
  return Object.fromEntries(sorted(total).map(([label, tally]) => [label, { calls: tally.calls, growthMB: Math.round(tally.growth / 1048576) }]));
}

let lastRss = 0;
let lastAt = 0;

/** Writes the line now; the timer calls this, and a test can too. `live` adds counts such as
 * watchers and sockets that only main.ts knows. */
export function logMemory(live: string): string {
  const rss = process.memoryUsage.rss();
  const now = Date.now();
  const change = rss - lastRss;
  let attributed = 0;
  for (const tally of recent.values()) attributed += tally.growth;
  const rows = sorted(recent)
    .slice(0, SHOWN)
    .map(([label, tally]) => `${label} ${tally.calls}× ${signed(tally.growth)}`);
  const minutes = Math.round((now - lastAt) / 60_000);
  const line =
    `[loom] memory: rss ${mb(rss)} (${signed(change)} in ${minutes} min) · js heap ${mb(heapStats().heapSize)} · ${live}` +
    ` · during requests: ${rows.length > 0 ? rows.join(", ") : "none"} · other ${signed(change - attributed)}`;
  console.log(line);
  recent.clear();
  lastRss = rss;
  lastAt = now;
  return line;
}

/** Starts the ten-minute line. LOOM_MEMORY_LOG_MS=0 turns it off. */
export function startMemoryLog(live: () => string): void {
  lastRss = process.memoryUsage.rss();
  lastAt = Date.now();
  if (!(PERIOD_MS > 0)) return;
  setInterval(() => logMemory(live()), PERIOD_MS).unref();
}
