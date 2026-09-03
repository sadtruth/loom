/**
 * Property and integration tests for budgets aggregation, Google quota parsing,
 * and Jules session count quota.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrentBudgets, resetBudgetsState } from "../../server/budgets.ts";
import { BUDGET_IDS } from "../../server/models.ts";
import { parseGoogleUsage, readCurrentGoogleQuota } from "../../server/quota-google.ts";
import { parseJulesSessions, JULES_WINDOW_MS } from "../../server/quota-jules.ts";
import { writeShared } from "../../server/usage.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-budgets-test-"));
  tempDirs.push(dir);
  return dir;
}

let defaultG1Stub = "";
let defaultJulesStub = "";

beforeEach(() => {
  resetBudgetsState();
  const dir = createTempDir();
  defaultG1Stub = join(dir, "default-g1.txt");
  writeFileSync(
    defaultG1Stub,
    [
      "Gemini Models\tWeekly Limit Remaining\t38%\t2026-09-06T09:42:54Z",
      "Gemini Models\tFive Hour Limit Remaining\t78%\t2026-09-01T17:48:30Z",
      "Claude and GPT models\tWeekly Limit Remaining\t74%\t2026-09-06T10:19:25Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-01T20:38:38Z",
    ].join("\n")
  );

  defaultJulesStub = join(dir, "default-jules.json");
  writeFileSync(
    defaultJulesStub,
    JSON.stringify({
      sessions: [
        { id: "s1", createTime: new Date(Date.now() - 3600_000).toISOString() },
        { id: "s2", createTime: new Date(Date.now() - 7200_000).toISOString() },
      ],
    })
  );

  const defaultAnthropicCache = join(dir, "default-anthropic.json");
  process.env["LOOM_QUOTA_CACHE"] = defaultAnthropicCache;
  writeShared({
    at: Date.now(),
    body: {
      limits: [{ kind: "session", percent: 45, severity: "normal", resets_at: "2026-09-01T20:00:00Z" }],
    },
  });

  process.env["LOOM_QUOTA_STUB_G1"] = defaultG1Stub;
  process.env["LOOM_QUOTA_STUB_JULES"] = defaultJulesStub;
});

afterEach(() => {
  delete process.env["LOOM_QUOTA_FAIL"];
  delete process.env["LOOM_QUOTA_STUB"];
  delete process.env["LOOM_QUOTA_STUB_GOOGLE"];
  delete process.env["LOOM_QUOTA_STUB_G1"];
  delete process.env["LOOM_QUOTA_STUB_G2"];
  delete process.env["LOOM_QUOTA_STUB_JULES"];
  delete process.env["LOOM_QUOTA_STUB_JULES_KEY1"];
  delete process.env["LOOM_QUOTA_STUB_JULES_KEY2"];
  delete process.env["LOOM_QUOTA_CACHE"];
  delete process.env["LOOM_QUOTA_CACHE_GOOGLE"];
  delete process.env["LOOM_QUOTA_CACHE_JULES"];
  delete process.env["LOOM_QUOTA_POLL_MS"];
  resetBudgetsState();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
});

describe("Google Quota Parser properties", () => {
  const lineGeminiWeekly = "Gemini Models\tWeekly Limit Remaining\t38%\t2026-09-06T09:42:54Z";
  const lineGeminiFiveHour = "Gemini Models\tFive Hour Limit Remaining\t78%\t2026-09-01T17:48:30Z";
  const lineThirdpartyWeekly = "Claude and GPT models\tWeekly Limit Remaining\t74%\t2026-09-06T10:19:25Z";
  const lineThirdpartyFiveHour = "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-01T20:38:38Z";

  const allLines = [lineGeminiWeekly, lineGeminiFiveHour, lineThirdpartyWeekly, lineThirdpartyFiveHour];

  function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const current = arr[i]!;
      const remaining = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(remaining)) {
        result.push([current, ...p]);
      }
    }
    return result;
  }

  test("all 24 line orderings parse to identical numbers and timestamps", () => {
    const allPerms = permutations(allLines);
    expect(allPerms.length).toBe(24);

    const now = 1_700_000_000_000;
    for (const perm of allPerms) {
      const raw = perm.join("\n");
      const parsed = parseGoogleUsage(raw, now);
      expect(parsed).not.toBeNull();
      expect(parsed?.gemini?.weekly?.percentRemaining).toBe(38);
      expect(parsed?.gemini?.weekly?.percentUsed).toBe(62);
      expect(parsed?.gemini?.weekly?.resetsAt).toBe(Date.parse("2026-09-06T09:42:54Z"));

      expect(parsed?.gemini?.fiveHour?.percentRemaining).toBe(78);
      expect(parsed?.gemini?.fiveHour?.percentUsed).toBe(22);
      expect(parsed?.gemini?.fiveHour?.resetsAt).toBe(Date.parse("2026-09-01T17:48:30Z"));

      expect(parsed?.thirdparty?.weekly?.percentRemaining).toBe(74);
      expect(parsed?.thirdparty?.weekly?.percentUsed).toBe(26);
      expect(parsed?.thirdparty?.weekly?.resetsAt).toBe(Date.parse("2026-09-06T10:19:25Z"));

      expect(parsed?.thirdparty?.fiveHour?.percentRemaining).toBe(100);
      expect(parsed?.thirdparty?.fiveHour?.percentUsed).toBe(0);
      expect(parsed?.thirdparty?.fiveHour?.resetsAt).toBe(Date.parse("2026-09-01T20:38:38Z"));
    }
  });

  test("extra unknown lines, headers, noise, and blank lines never distort data", () => {
    const now = 1_700_000_000_000;
    const noiseVariations = [
      ["Quota:", ...allLines],
      ["", "   ", ...allLines, "Some random trailing text", "12345"],
      [
        "Ollama Models\tWeekly Limit Remaining\t50%\t2026-09-06T09:42:54Z",
        lineGeminiFiveHour,
        "Unknown Pool\tFive Hour Limit\t10%\t2026-09-01T17:48:30Z",
        lineThirdpartyFiveHour,
      ],
      [lineGeminiWeekly, "Gemini Models\tMonthly Limit Remaining\t99%\t2026-10-01T00:00:00Z", lineThirdpartyWeekly],
    ];

    for (const lines of noiseVariations) {
      const parsed = parseGoogleUsage(lines.join("\n"), now);
      expect(parsed).not.toBeNull();
      if (lines.includes(lineGeminiFiveHour)) {
        expect(parsed?.gemini?.fiveHour?.percentRemaining).toBe(78);
        expect(parsed?.gemini?.fiveHour?.percentUsed).toBe(22);
      }
      if (lines.includes(lineThirdpartyFiveHour)) {
        expect(parsed?.thirdparty?.fiveHour?.percentRemaining).toBe(100);
        expect(parsed?.thirdparty?.fiveHour?.percentUsed).toBe(0);
      }
    }
  });

  test("missing lines result in null for the missing window/pool, never fabricated values", () => {
    const now = 1_700_000_000_000;

    // Only Gemini 5-hour
    const parsedGeminiOnly = parseGoogleUsage(lineGeminiFiveHour, now);
    expect(parsedGeminiOnly).not.toBeNull();
    expect(parsedGeminiOnly?.gemini?.fiveHour?.percentRemaining).toBe(78);
    expect(parsedGeminiOnly?.gemini?.weekly).toBeNull();
    expect(parsedGeminiOnly?.thirdparty).toBeNull();

    // Only Thirdparty Weekly
    const parsedThirdOnly = parseGoogleUsage(lineThirdpartyWeekly, now);
    expect(parsedThirdOnly).not.toBeNull();
    expect(parsedThirdOnly?.gemini).toBeNull();
    expect(parsedThirdOnly?.thirdparty?.weekly?.percentRemaining).toBe(74);
    expect(parsedThirdOnly?.thirdparty?.fiveHour).toBeNull();

    // Empty or purely invalid input
    expect(parseGoogleUsage("", now)).toBeNull();
    expect(parseGoogleUsage("random garbage without tabs or valid pools", now)).toBeNull();
  });

  test("whitespace variations (spaces, tabs, trailing spaces) parse accurately", () => {
    const now = 1_700_000_000_000;
    const variedLines = [
      "Gemini Models \t Weekly Limit Remaining \t 38% \t 2026-09-06T09:42:54Z ",
      "Gemini Models\t\tFive Hour Limit Remaining\t\t78%\t\t2026-09-01T17:48:30Z",
      "Claude and GPT models   Weekly Limit Remaining   74%   2026-09-06T10:19:25Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-01T20:38:38Z\r\n",
    ].join("\n");

    const parsed = parseGoogleUsage(variedLines, now);
    expect(parsed).not.toBeNull();
    expect(parsed?.gemini?.weekly?.percentRemaining).toBe(38);
    expect(parsed?.gemini?.fiveHour?.percentRemaining).toBe(78);
    expect(parsed?.thirdparty?.weekly?.percentRemaining).toBe(74);
    expect(parsed?.thirdparty?.fiveHour?.percentRemaining).toBe(100);
  });

  test("reworded window names that do not match known windows return null/skipped", () => {
    const now = 1_700_000_000_000;
    const unrecog = "Gemini Models\tQuarterly Limit Remaining\t50%\t2026-09-06T09:42:54Z";
    expect(parseGoogleUsage(unrecog, now)).toBeNull();
  });

  test("percentage is always clamped to [0, 100], whatever the input said", () => {
    const now = 1_700_000_000_000;
    const testCases = [
      { raw: "Gemini Models\tFive Hour Limit Remaining\t150%\t2026-09-01T17:48:30Z", expectedRem: 100, expectedUsed: 0 },
      { raw: "Gemini Models\tFive Hour Limit Remaining\t-25%\t2026-09-01T17:48:30Z", expectedRem: 0, expectedUsed: 100 },
      { raw: "Gemini Models\tFive Hour Limit Remaining\t999%\t2026-09-01T17:48:30Z", expectedRem: 100, expectedUsed: 0 },
      { raw: "Gemini Models\tFive Hour Limit Remaining\t0%\t2026-09-01T17:48:30Z", expectedRem: 0, expectedUsed: 100 },
      { raw: "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-09-01T17:48:30Z", expectedRem: 100, expectedUsed: 0 },
    ];

    for (const tc of testCases) {
      const parsed = parseGoogleUsage(tc.raw, now);
      expect(parsed?.gemini?.fiveHour?.percentRemaining).toBe(tc.expectedRem);
      expect(parsed?.gemini?.fiveHour?.percentUsed).toBe(tc.expectedUsed);
    }
  });
});

describe("Jules Quota Parser properties", () => {
  test("counts only sessions strictly within the last 24-hour window", () => {
    const now = 1_700_000_000_000;
    const h = 60 * 60 * 1000;

    const rawSessions = {
      sessions: [
        { id: "s1", createTime: new Date(now - 1 * h).toISOString() }, // 1h ago -> in window
        { id: "s2", createTime: new Date(now - 10 * h).toISOString() }, // 10h ago -> in window
        { id: "s3", createTime: new Date(now - 23 * h).toISOString() }, // 23h ago -> in window
        { id: "s4", createTime: new Date(now - 25 * h).toISOString() }, // 25h ago -> outside window
        { id: "s5", createTime: new Date(now - 100 * h).toISOString() }, // 100h ago -> outside window
        { id: "s6", createTime: "invalid date" }, // invalid -> ignored
        { id: "s7" }, // missing -> ignored
      ],
    };

    const quota = parseJulesSessions(rawSessions, now, 100);
    expect(quota).not.toBeNull();
    expect(quota?.used).toBe(3);
    expect(quota?.ceiling).toBe(100);
    expect(quota?.percentUsed).toBe(3); // 3 / 100 * 100 = 3%
    expect(quota?.percentRemaining).toBe(97);

    // Oldest session in window is s3 (now - 23h). It resets at s3 + 24h = now + 1h.
    const expectedOldest = Date.parse(new Date(now - 23 * h).toISOString());
    expect(quota?.resetsAt).toBe(expectedOldest + JULES_WINDOW_MS);
  });

  test("handles zero sessions and empty response gracefully", () => {
    const now = 1_700_000_000_000;
    const quota = parseJulesSessions({ sessions: [] }, now, 100);
    expect(quota).not.toBeNull();
    expect(quota?.used).toBe(0);
    expect(quota?.percentUsed).toBe(0);
    expect(quota?.percentRemaining).toBe(100);
    expect(quota?.resetsAt).toBeNull();
  });

  test("percent is clamped between 0 and 100 even with huge session count", () => {
    const now = 1_700_000_000_000;
    const manySessions = Array.from({ length: 300 }, (_, i) => ({
      createTime: new Date(now - (i % 20) * 60 * 1000).toISOString(),
    }));

    const quota = parseJulesSessions({ sessions: manySessions }, now, 100);
    expect(quota?.used).toBe(300);
    expect(quota?.percentUsed).toBe(100);
    expect(quota?.percentRemaining).toBe(0);
  });
});

describe("Budgets Aggregator properties and fault isolation", () => {
  test("contains all four BUDGET_IDS in correct order", async () => {
    const report = await readCurrentBudgets();
    expect(report.list.length).toBe(4);
    expect(Object.keys(report.budgets).length).toBe(4);
    expect(report.list.map((b) => b.id)).toEqual([...BUDGET_IDS]);
    for (const id of BUDGET_IDS) {
      expect(report.budgets[id]).toBeDefined();
      expect(report.budgets[id].id).toBe(id);
      expect(report.budgets[id].percentKind).toBe("used");
    }
  });

  test("one budget failing leaves the other three readable", async () => {
    const dir = createTempDir();
    const g1Stub = join(dir, "g1-stub.txt");
    writeFileSync(
      g1Stub,
      [
        "Gemini Models\tFive Hour Limit Remaining\t70%\t2026-09-01T17:48:30Z",
        "Claude and GPT models\tFive Hour Limit Remaining\t80%\t2026-09-01T20:38:38Z",
      ].join("\n")
    );

    const anthropicCache = join(dir, "anthropic-cache.json");
    process.env["LOOM_QUOTA_CACHE"] = anthropicCache;
    writeShared({
      at: Date.now(),
      body: {
        limits: [{ kind: "session", percent: 45, severity: "normal", resets_at: "2026-09-01T20:00:00Z" }],
      },
    });

    const julesStub = join(dir, "missing-jules.json");
    writeFileSync(julesStub, "invalid json");

    process.env["LOOM_QUOTA_STUB_G1"] = g1Stub;
    process.env["LOOM_QUOTA_STUB_JULES"] = julesStub;

    const report = await readCurrentBudgets();

    // Anthropic: ok (45% used)
    expect(report.budgets["anthropic"].status).toBe("ok");
    expect(report.budgets["anthropic"].percent).toBe(45);

    // G1 Gemini: ok (30% used, 100 - 70)
    expect(report.budgets["g1:gemini"].status).toBe("ok");
    expect(report.budgets["g1:gemini"].percent).toBe(30);

    // G1 Thirdparty: ok (20% used, 100 - 80)
    expect(report.budgets["g1:thirdparty"].status).toBe("ok");
    expect(report.budgets["g1:thirdparty"].percent).toBe(20);

    // Jules (failing): unavailable, with clear reason
    expect(report.budgets["jules"].status).toBe("unavailable");
    expect(report.budgets["jules"].reason).toBeDefined();
  });

  test("all four budgets report ok when all providers are healthy", async () => {
    const dir = createTempDir();
    const g1Stub = join(dir, "g1-stub.txt");
    writeFileSync(
      g1Stub,
      [
        "Gemini Models\tFive Hour Limit Remaining\t70%\t2026-09-01T17:48:30Z",
        "Claude and GPT models\tFive Hour Limit Remaining\t80%\t2026-09-01T20:38:38Z",
      ].join("\n")
    );

    const julesStub = join(dir, "jules-stub.json");
    writeFileSync(
      julesStub,
      JSON.stringify({
        sessions: Array.from({ length: 25 }, (_, i) => ({
          createTime: new Date(Date.now() - i * 1000 * 60).toISOString(),
        })),
      })
    );

    const anthropicCache = join(dir, "anthropic-cache.json");
    process.env["LOOM_QUOTA_CACHE"] = anthropicCache;
    writeShared({
      at: Date.now(),
      body: {
        limits: [{ kind: "session", percent: 45, severity: "normal", resets_at: "2026-09-01T20:00:00Z" }],
      },
    });

    process.env["LOOM_QUOTA_STUB_G1"] = g1Stub;
    process.env["LOOM_QUOTA_STUB_JULES"] = julesStub;

    const report = await readCurrentBudgets();

    expect(report.list.length).toBe(4);
    expect(Object.keys(report.budgets).length).toBe(4);

    expect(report.budgets["anthropic"].status).toBe("ok");
    expect(report.budgets["anthropic"].percent).toBe(45);

    expect(report.budgets["g1:gemini"].status).toBe("ok");
    expect(report.budgets["g1:gemini"].percent).toBe(30);

    expect(report.budgets["g1:thirdparty"].status).toBe("ok");
    expect(report.budgets["g1:thirdparty"].percent).toBe(20);

    expect(report.budgets["jules"].status).toBe("ok");
    expect(report.budgets["jules"].percent).toBe(25);
  });

  test("a stale reading is always marked stale, for any age", async () => {
    const dir = createTempDir();
    const g1Stub = join(dir, "g1-stub.txt");
    writeFileSync(
      g1Stub,
      "Gemini Models\tFive Hour Limit Remaining\t78%\t2026-09-01T17:48:30Z\nClaude and GPT models\tFive Hour Limit Remaining\t90%\t2026-09-01T20:38:38Z"
    );
    process.env["LOOM_QUOTA_STUB_G1"] = g1Stub;

    // First poll succeeds
    const firstReading = await readCurrentGoogleQuota("google-account-1");
    expect(firstReading.stale).toBe(false);
    expect(firstReading.quota).not.toBeNull();

    // Now induce failure with LOOM_QUOTA_FAIL
    process.env["LOOM_QUOTA_FAIL"] = "1";
    process.env["LOOM_QUOTA_POLL_MS"] = "1"; // allow immediate poll

    // Test with various future timestamps (1 second, 1 hour, 10 days)
    const ages = [1_000, 3_600_000, 10 * 24 * 3_600_000];
    for (const age of ages) {
      const now = Date.now() + age;
      const failedReading = await readCurrentGoogleQuota("google-account-1", now);
      expect(failedReading.stale).toBe(true);
      expect(failedReading.quota).not.toBeNull();
      expect(failedReading.quota?.gemini?.fiveHour?.percentUsed).toBe(22);
    }
  });

  test("LOOM_QUOTA_FAIL sets all budgets to degraded or unavailable states", async () => {
    process.env["LOOM_QUOTA_FAIL"] = "1";
    const report = await readCurrentBudgets();
    for (const id of BUDGET_IDS) {
      const b = report.budgets[id];
      expect(b.status).not.toBe("ok");
      expect(b.reason).not.toBeNull();
    }
  });

  test("Jules budget aggregates both key 1 and key 2 readings summed against both ceilings", async () => {
    const dir = createTempDir();
    const k1Stub = join(dir, "jules-k1.json");
    const k2Stub = join(dir, "jules-k2.json");

    // Test matrix of per-key session counts
    const pairs = [
      { k1: 25, k2: 18, expectedUsed: 43, expectedLimit: 200, expectedPercent: 21.5 },
      { k1: 0, k2: 0, expectedUsed: 0, expectedLimit: 200, expectedPercent: 0 },
      { k1: 50, k2: 100, expectedUsed: 150, expectedLimit: 200, expectedPercent: 75 },
      { k1: 100, k2: 100, expectedUsed: 200, expectedLimit: 200, expectedPercent: 100 },
    ];

    for (const pair of pairs) {
      resetBudgetsState();
      writeFileSync(
        k1Stub,
        JSON.stringify({
          sessions: Array.from({ length: pair.k1 }, (_, i) => ({
            createTime: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
          })),
        })
      );
      writeFileSync(
        k2Stub,
        JSON.stringify({
          sessions: Array.from({ length: pair.k2 }, (_, i) => ({
            createTime: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
          })),
        })
      );

      process.env["LOOM_QUOTA_STUB_JULES_KEY1"] = k1Stub;
      process.env["LOOM_QUOTA_STUB_JULES_KEY2"] = k2Stub;
      delete process.env["LOOM_QUOTA_STUB_JULES"];

      const report = await readCurrentBudgets();
      const jules = report.budgets["jules"];

      expect(jules.status).toBe("ok");
      expect(jules.absolute).toEqual({ used: pair.expectedUsed, limit: pair.expectedLimit });
      expect(jules.percent).toBe(pair.expectedPercent);
    }
  });

  test("Jules budget isolates single-key failure: reports available key and names missing key in reason", async () => {
    const dir = createTempDir();
    const k1Stub = join(dir, "jules-k1.json");
    const k2Stub = join(dir, "jules-k2.json");

    // Key 1 succeeds (25 sessions), Key 2 fails (invalid JSON / missing)
    resetBudgetsState();
    writeFileSync(
      k1Stub,
      JSON.stringify({
        sessions: Array.from({ length: 25 }, (_, i) => ({
          createTime: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        })),
      })
    );
    writeFileSync(k2Stub, "invalid json");

    process.env["LOOM_QUOTA_STUB_JULES_KEY1"] = k1Stub;
    process.env["LOOM_QUOTA_STUB_JULES_KEY2"] = k2Stub;
    delete process.env["LOOM_QUOTA_STUB_JULES"];

    const reportK1Only = await readCurrentBudgets();
    const julesK1Only = reportK1Only.budgets["jules"];

    expect(julesK1Only.status).toBe("stale");
    expect(julesK1Only.absolute).toEqual({ used: 25, limit: 100 });
    expect(julesK1Only.percent).toBe(25); // 25 / 100 * 100
    expect(julesK1Only.reason).toMatch(/key\s*2/i);

    // Key 2 succeeds (18 sessions), Key 1 fails
    resetBudgetsState();
    writeFileSync(k1Stub, "invalid json");
    writeFileSync(
      k2Stub,
      JSON.stringify({
        sessions: Array.from({ length: 18 }, (_, i) => ({
          createTime: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        })),
      })
    );

    const reportK2Only = await readCurrentBudgets();
    const julesK2Only = reportK2Only.budgets["jules"];

    expect(julesK2Only.status).toBe("stale");
    expect(julesK2Only.absolute).toEqual({ used: 18, limit: 100 });
    expect(julesK2Only.percent).toBe(18); // 18 / 100 * 100
    expect(julesK2Only.reason).toMatch(/key\s*1/i);
  });

  test("Google pool headline percent equals the worse (maximum percent used) of five-hour and weekly windows and carries winning window reset time", async () => {
    const dir = createTempDir();
    const g1Stub = join(dir, "g1-prop-stub.txt");

    const percentages = [0, 2, 15, 38, 50, 63, 80, 100];
    const baseTime = Date.parse("2026-09-01T12:00:00Z");

    for (const fiveHourUsed of percentages) {
      for (const weeklyUsed of percentages) {
        resetBudgetsState();

        const fiveHourRem = 100 - fiveHourUsed;
        const weeklyRem = 100 - weeklyUsed;
        const fiveHourResetStr = "2026-09-01T17:00:00Z";
        const weeklyResetStr = "2026-09-08T12:00:00Z";
        const fiveHourResetMs = Date.parse(fiveHourResetStr);
        const weeklyResetMs = Date.parse(weeklyResetStr);

        writeFileSync(
          g1Stub,
          [
            `Gemini Models\tFive Hour Limit Remaining\t${fiveHourRem}%\t${fiveHourResetStr}`,
            `Gemini Models\tWeekly Limit Remaining\t${weeklyRem}%\t${weeklyResetStr}`,
            `Claude and GPT models\tFive Hour Limit Remaining\t${fiveHourRem}%\t${fiveHourResetStr}`,
            `Claude and GPT models\tWeekly Limit Remaining\t${weeklyRem}%\t${weeklyResetStr}`,
          ].join("\n")
        );

        process.env["LOOM_QUOTA_STUB_G1"] = g1Stub;
        const report = await readCurrentBudgets(baseTime);

        const expectedHeadline = Math.max(fiveHourUsed, weeklyUsed);
        const expectedReset = fiveHourUsed >= weeklyUsed ? fiveHourResetMs : weeklyResetMs;

        const gemini = report.budgets["g1:gemini"];
        expect(gemini.status).toBe("ok");
        expect(gemini.percent).toBe(expectedHeadline);
        expect(gemini.resetsAt).toBe(expectedReset);
        expect(gemini.fiveHour).toEqual({ percent: fiveHourUsed, resetsAt: fiveHourResetMs });
        expect(gemini.weekly).toEqual({ percent: weeklyUsed, resetsAt: weeklyResetMs });

        const thirdparty = report.budgets["g1:thirdparty"];
        expect(thirdparty.status).toBe("ok");
        expect(thirdparty.percent).toBe(expectedHeadline);
        expect(thirdparty.resetsAt).toBe(expectedReset);
        expect(thirdparty.fiveHour).toEqual({ percent: fiveHourUsed, resetsAt: fiveHourResetMs });
        expect(thirdparty.weekly).toEqual({ percent: weeklyUsed, resetsAt: weeklyResetMs });
      }
    }
  });
});

