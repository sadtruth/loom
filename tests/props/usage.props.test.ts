/**
 * P — pin `readQuota` (server/usage.ts) against the REAL `/api/oauth/usage` response.
 *
 * `REAL_BODY` below is the response recorded verbatim in `usage-bar/project.md`, captured live
 * 2026-08-26. Two `resets_at` values inside `limits[]` were elided there as `"…"` — the record
 * shows the same window's flat `resets_at` right next to each one, and a session/weekly reset is
 * one clock, not two, so those two fields are filled in from their paired flat object. Every
 * other field — every `percent`, `severity`, `utilization`, the scoped row's label — is copied
 * character for character.
 *
 * The RED run this pin is supposed to have failed against: a version of `readQuota` with no
 * `limits`-array branch — i.e. reading `five_hour`/`seven_day` only — asserted the same
 * disagreement case below and got `Received: 40` where `55` (the `limits` value) was expected.
 * That output is quoted in the build report, not reproduced here, because reproducing it would
 * mean shipping the broken branch.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readQuota, type Severity } from "../../server/usage.ts";

const AT = 1_798_000_000_000;

/** The real body, `usage-bar/project.md` — two `resets_at` filled in from the paired flat window
 *  (see file header). */
const REAL_BODY = {
  five_hour: { utilization: 55.0, resets_at: "2026-08-26T11:59:59.912643+00:00" },
  seven_day: { utilization: 56.0, resets_at: "2026-08-28T19:59:59.912669+00:00" },
  limits: [
    {
      kind: "session",
      percent: 55,
      severity: "normal",
      resets_at: "2026-08-26T11:59:59.912643+00:00", // filled in — see file header
    },
    {
      kind: "weekly_all",
      percent: 56,
      severity: "normal",
      resets_at: "2026-08-28T19:59:59.912669+00:00", // filled in — see file header
    },
    { kind: "weekly_scoped", percent: 2, scope: { model: { display_name: "Fable" } } },
  ],
};

describe("readQuota, pinned to the real response", () => {
  test("five-hour 55, weekly 56, one scoped Fable at 2", () => {
    const q = readQuota(REAL_BODY, AT);
    expect(q).not.toBeNull();
    expect(q!.fiveHour).toEqual({
      percent: 55,
      resetsAt: Date.parse("2026-08-26T11:59:59.912643+00:00"),
      severity: "normal",
    });
    expect(q!.weekly).toEqual({
      percent: 56,
      resetsAt: Date.parse("2026-08-28T19:59:59.912669+00:00"),
      severity: "normal",
    });
    expect(q!.scoped).toEqual([{ label: "Fable", percent: 2, resetsAt: null }]);
    expect(q!.at).toBe(AT);
  });

  test("DISAGREEMENT: limits and the flat object differ — limits wins", () => {
    const body = {
      five_hour: { utilization: 40, resets_at: "2026-08-26T11:59:59.912643+00:00" },
      seven_day: { utilization: 20, resets_at: "2026-08-28T19:59:59.912669+00:00" },
      limits: [
        { kind: "session", percent: 55, severity: "warning", resets_at: "2026-08-26T12:00:00.000000+00:00" },
        { kind: "weekly_all", percent: 56, severity: "critical", resets_at: "2026-08-28T20:00:00.000000+00:00" },
      ],
    };
    const q = readQuota(body, AT);
    expect(q!.fiveHour!.percent).toBe(55);
    expect(q!.fiveHour!.severity).toBe("warning");
    expect(q!.weekly!.percent).toBe(56);
    expect(q!.weekly!.severity).toBe("critical");
  });

  test("the stub file path never touches the network — LOOM_QUOTA_STUB", async () => {
    const { readCurrentQuota, resetQuotaState } = await import("../../server/usage.ts");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "loom-quota-"));
    const stubPath = join(dir, "stub.json");
    await writeFile(stubPath, JSON.stringify(REAL_BODY));
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    // @ts-expect-error — test seam: prove the network is never reached while the stub is set.
    globalThis.fetch = (...args: unknown[]) => {
      fetchCalled = true;
      throw new Error("network reached despite LOOM_QUOTA_STUB");
    };
    process.env["LOOM_QUOTA_STUB"] = stubPath;
    resetQuotaState();
    try {
      const { quota, stale } = await readCurrentQuota(AT);
      expect(stale).toBe(false);
      expect(quota).not.toBeNull();
      expect(quota!.fiveHour!.percent).toBe(55);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env["LOOM_QUOTA_STUB"];
      resetQuotaState();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("LOOM_QUOTA_FAIL behaves exactly as a failed fetch — stale, no reading, no network", async () => {
    const { readCurrentQuota, resetQuotaState } = await import("../../server/usage.ts");
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    // @ts-expect-error — test seam.
    globalThis.fetch = (...args: unknown[]) => {
      fetchCalled = true;
      throw new Error("network reached despite LOOM_QUOTA_FAIL");
    };
    process.env["LOOM_QUOTA_FAIL"] = "1";
    resetQuotaState();
    try {
      const { quota, stale } = await readCurrentQuota(AT);
      expect(stale).toBe(true);
      expect(quota).toBeNull();
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env["LOOM_QUOTA_FAIL"];
      resetQuotaState();
    }
  });
});

describe("readQuota never throws", () => {
  const junkArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.anything()),
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.record(
      {
        five_hour: fc.oneof(fc.anything(), fc.record({ utilization: fc.anything(), resets_at: fc.anything() })),
        seven_day: fc.oneof(fc.anything(), fc.record({ utilization: fc.anything(), resets_at: fc.anything() })),
        limits: fc.oneof(
          fc.anything(),
          fc.array(
            fc.oneof(
              fc.anything(),
              fc.record(
                {
                  kind: fc.oneof(fc.constantFrom("session", "weekly_all", "weekly_scoped"), fc.string(), fc.anything()),
                  percent: fc.anything(),
                  severity: fc.anything(),
                  resets_at: fc.anything(),
                  scope: fc.oneof(fc.anything(), fc.record({ model: fc.anything() }, { requiredKeys: [] })),
                },
                { requiredKeys: [] },
              ),
            ),
          ),
        ),
      },
      { requiredKeys: [] },
    ),
  );

  const SEVERITIES: readonly Severity[] = ["normal", "warning", "critical"];

  test("PROPERTY: for any junk body, readQuota returns null or a well-formed Quota, and never throws", () => {
    fc.assert(
      fc.property(junkArb, fc.integer({ min: 0, max: 2_000_000_000_000 }), (body, at) => {
        let result: ReturnType<typeof readQuota>;
        expect(() => {
          result = readQuota(body, at);
        }).not.toThrow();
        result = readQuota(body, at);
        if (result === null) return;
        expect(result.at).toBe(at);
        for (const w of [result.fiveHour, result.weekly]) {
          if (w === null) continue;
          expect(Number.isFinite(w.percent)).toBe(true);
          expect(w.percent).toBeGreaterThanOrEqual(0);
          expect(w.percent).toBeLessThanOrEqual(100);
          expect(w.resetsAt === null || Number.isFinite(w.resetsAt)).toBe(true);
          expect(SEVERITIES.includes(w.severity)).toBe(true);
        }
        for (const s of result.scoped) {
          expect(typeof s.label).toBe("string");
          expect(Number.isFinite(s.percent)).toBe(true);
          expect(s.percent).toBeGreaterThanOrEqual(0);
          expect(s.percent).toBeLessThanOrEqual(100);
          expect(s.resetsAt === null || Number.isFinite(s.resetsAt)).toBe(true);
        }
      }),
    );
  });

  test("PROPERTY: an absent resets_at never throws and yields resetsAt: null", () => {
    fc.assert(
      fc.property(fc.float({ min: 0, max: 100, noNaN: true }), (percent) => {
        const q = readQuota({ five_hour: { utilization: percent } }, AT);
        expect(q).not.toBeNull();
        expect(q!.fiveHour!.resetsAt).toBeNull();
      }),
    );
  });
});
