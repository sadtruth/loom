/**
 * The memory log (server/memlog.ts, record item 97). Wrapping must not change what a route
 * answers, must leave static responses and HTML bundles alone, and must book every call.
 */
import { describe, expect, test } from "bun:test";
import { instrumentRoutes, instrumentSocket, logMemory, requestTotals, track } from "../../server/memlog.ts";

describe("memlog", () => {
  test("a wrapped route answers exactly what the bare one did, sync or async", async () => {
    const routes = instrumentRoutes({
      "/sync": () => new Response("a"),
      "/async": async () => new Response("b"),
      "/methods": { GET: () => new Response("c"), POST: async () => new Response("d") },
    });
    expect(await routes["/sync"]().text()).toBe("a");
    expect(await (await routes["/async"]()).text()).toBe("b");
    expect(await routes["/methods"].GET().text()).toBe("c");
    expect(await (await routes["/methods"].POST()).text()).toBe("d");
    const totals = requestTotals();
    expect(totals["/sync"]?.calls).toBe(1);
    expect(totals["/async"]?.calls).toBe(1);
    expect(totals["GET /methods"]?.calls).toBe(1);
    expect(totals["POST /methods"]?.calls).toBe(1);
  });

  test("static responses and non-method objects pass through untouched", () => {
    const fixed = new Response("x");
    const bundle = { index: "index.html", files: [] };
    const routes = instrumentRoutes({ "/fixed": fixed, "/": bundle });
    expect(routes["/fixed"]).toBe(fixed);
    expect(routes["/"]).toBe(bundle);
  });

  test("a throwing handler still throws, and a rejected one still rejects", async () => {
    expect(() => track("boom", () => { throw new Error("sync"); })).toThrow("sync");
    await expect(track("boom", async () => { throw new Error("async"); })).rejects.toThrow("async");
  });

  test("socket handlers are tracked by name", async () => {
    let opened = 0;
    const socket = instrumentSocket({ open: () => { opened++; }, message: () => {} });
    socket.open();
    socket.open();
    expect(opened).toBe(2);
    expect(requestTotals()["ws open"]?.calls).toBe(2);
  });

  test("the log line names the process size, the heap and the busiest kinds of request", () => {
    logMemory(""); // start a fresh period, so the earlier tests' calls do not crowd the line
    track("/api/example", () => new Uint8Array(1024));
    const line = logMemory("watchers 0 · sockets 0");
    expect(line).toMatch(/^\[loom\] memory: rss \d+ MB \([+−]\d+ MB in \d+ min\) · js heap \d+ MB · watchers 0 · sockets 0 · during requests: .*\/api\/example 1× [+−]\d+ MB.* · other [+−]\d+ MB$/);
    // The counts since the last line start over; the totals since start do not.
    expect(logMemory("")).toContain("during requests: none");
    expect(requestTotals()["/api/example"]?.calls).toBe(1);
  });
});
