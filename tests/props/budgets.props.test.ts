/**
 * Property and integration tests for budgets aggregation and Google quota parsing.
 *
 * Jules' parser tests and the Anthropic entry left this file on 2026-11-24 with the code they
 * covered; the Command Code case that replaced them is in `quota-commandcode.props.test.ts`, and
 * the aggregator cases here stub its endpoint the same way they stub the Google one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrentBudgets, resetBudgetsState } from "../../server/budgets.ts";
import { BUDGET_IDS } from "../../server/models.ts";
import { parseGoogleUsage, readCurrentGoogleQuota } from "../../server/quota-google.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-budgets-test-"));
  tempDirs.push(dir);
  return dir;
}

let defaultG1Stub = "";
let defaultCommandCodeStub = "";

/** A healthy Command Code reading: 25% of the 5-hour window, 10% of the week, 5.7% of the month. */
function commandCodeStubBody(): string {
  return JSON.stringify({
    credits: {
      credits: { monthlyCredits: 66, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        exceeded: null,
        fiveHour: { used: 3.5, cap: 14, exceeded: false, resetAt: 1_800_000_000_000 },
        weekly: { used: 3.5, cap: 35, exceeded: false, resetAt: 1_800_500_000_000 },
      },
    },
    subscription: { data: { planId: "individual-goat", currentPeriodEnd: "2026-12-23T21:07:01.000Z" } },
  });
}

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

  defaultCommandCodeStub = join(dir, "default-commandcode.json");
  writeFileSync(defaultCommandCodeStub, commandCodeStubBody());

  process.env["LOOM_QUOTA_STUB_G1"] = defaultG1Stub;
  process.env["LOOM_QUOTA_STUB_COMMANDCODE"] = defaultCommandCodeStub;
});

afterEach(() => {
  delete process.env["LOOM_QUOTA_FAIL"];
  delete process.env["LOOM_QUOTA_STUB"];
  delete process.env["LOOM_QUOTA_STUB_GOOGLE"];
  delete process.env["LOOM_QUOTA_STUB_G1"];
  delete process.env["LOOM_QUOTA_STUB_G2"];
  delete process.env["LOOM_QUOTA_STUB_COMMANDCODE"];
  delete process.env["LOOM_QUOTA_CACHE"];
  delete process.env["LOOM_QUOTA_CACHE_GOOGLE"];
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

describe("Budgets Aggregator properties and fault isolation", () => {
  test("contains every BUDGET_ID once, in order", async () => {
    const report = await readCurrentBudgets();
    expect(report.list.length).toBe(BUDGET_IDS.length);
    expect(Object.keys(report.budgets).length).toBe(BUDGET_IDS.length);
    expect(report.list.map((b) => b.id)).toEqual([...BUDGET_IDS]);
    for (const id of BUDGET_IDS) {
      expect(report.budgets[id]).toBeDefined();
      expect(report.budgets[id].id).toBe(id);
      expect(report.budgets[id].percentKind).toBe("used");
    }
  });

  test("Command Code's headline is its worst window and carries that window's reset", async () => {
    const report = await readCurrentBudgets();
    const cc = report.budgets["commandcode"];
    expect(cc.status).toBe("ok");
    // fiveHour 3.5/14 = 25%, weekly 3.5/35 = 10%, monthly (70-66)/70 = 5.714%.
    expect(cc.fiveHour).toEqual({ percent: 25, resetsAt: 1_800_000_000_000 });
    expect(cc.weekly).toEqual({ percent: 10, resetsAt: 1_800_500_000_000 });
    expect(cc.monthly?.percent).toBeCloseTo((4 / 70) * 100, 6);
    expect(cc.monthly?.resetsAt).toBe(Date.parse("2026-12-23T21:07:01.000Z"));
    expect(cc.percent).toBe(25);
    expect(cc.resetsAt).toBe(1_800_000_000_000);
  });

  test("one budget failing leaves the others readable", async () => {
    const dir = createTempDir();
    const g1Stub = join(dir, "g1-stub.txt");
    writeFileSync(
      g1Stub,
      [
        "Gemini Models\tFive Hour Limit Remaining\t70%\t2026-09-01T17:48:30Z",
        "Claude and GPT models\tFive Hour Limit Remaining\t80%\t2026-09-01T20:38:38Z",
      ].join("\n")
    );

    const missingCommandCode = join(dir, "missing-commandcode.json");
    writeFileSync(missingCommandCode, "invalid json");

    process.env["LOOM_QUOTA_STUB_G1"] = g1Stub;
    process.env["LOOM_QUOTA_STUB_COMMANDCODE"] = missingCommandCode;

    const report = await readCurrentBudgets();

    // G1 Gemini: ok (30% used, 100 - 70)
    expect(report.budgets["g1:gemini"].status).toBe("ok");
    expect(report.budgets["g1:gemini"].percent).toBe(30);

    // G1 Thirdparty: ok (20% used, 100 - 80)
    expect(report.budgets["g1:thirdparty"].status).toBe("ok");
    expect(report.budgets["g1:thirdparty"].percent).toBe(20);

    // Command Code (failing): unavailable, with a clear reason
    expect(report.budgets["commandcode"].status).toBe("unavailable");
    expect(report.budgets["commandcode"].reason).toBeDefined();
  });

  test("all budgets report ok when every provider is healthy", async () => {
    const report = await readCurrentBudgets();

    expect(report.list.length).toBe(BUDGET_IDS.length);
    expect(Object.keys(report.budgets).length).toBe(BUDGET_IDS.length);

    expect(report.budgets["commandcode"].status).toBe("ok");
    // The seeded Google stub: Gemini 78% five-hour remaining / 38% weekly remaining, so the
    // headline is the worse window at 62% used; Claude-and-GPT 100% / 74% remaining → 26%.
    expect(report.budgets["g1:gemini"].status).toBe("ok");
    expect(report.budgets["g1:gemini"].percent).toBe(62);
    expect(report.budgets["g1:thirdparty"].status).toBe("ok");
    expect(report.budgets["g1:thirdparty"].percent).toBe(26);
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

  test("LOOM_QUOTA_FAIL sets every budget to a degraded or unavailable state", async () => {
    process.env["LOOM_QUOTA_FAIL"] = "1";
    const report = await readCurrentBudgets();
    for (const id of BUDGET_IDS) {
      const b = report.budgets[id];
      expect(b.status).not.toBe("ok");
      expect(b.reason).not.toBeNull();
    }
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
