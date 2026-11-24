/**
 * Command Code quota properties — server/quota-commandcode.ts.
 *
 * The first case is the endpoint's REAL answer, recorded 2026-11-24 from the box's own key
 * (`/alpha/billing/credits` + `/alpha/billing/subscriptions`). A fixture built from the parser's
 * own assumptions would pass while the parser was wrong; this one cannot.
 *
 * The properties are the rules the panel depends on: percent never leaves 0..100, a bigger spend
 * never lowers a percent, a missing window is null rather than zero, and a body nobody recognizes
 * yields null instead of a fabricated reading.
 */

import { describe, expect, test } from "bun:test";
import { parseCommandCodeLimits, planPool } from "../../server/quota-commandcode.ts";

/** Recorded live, 2026-11-24. Values in credits; `monthlyCredits` is what is LEFT. */
const REAL_CREDITS = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 69.5149028266, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.4640194272, cap: 14, exceeded: false, resetAt: 1795525232195 },
    weekly: { used: 0.4850971734, cap: 35, exceeded: false, resetAt: 1796074101408 },
  },
  sandboxAccess: true,
};

const REAL_SUBSCRIPTION = {
  success: true,
  data: {
    id: "sub_1Uf4S6DSZgxV3MJKoYzqhYQ1",
    status: "active",
    planId: "individual-goat",
    currentPeriodStart: "2026-11-23T21:07:01.000Z",
    currentPeriodEnd: "2026-12-23T21:07:01.000Z",
  },
};

const AT = 1_795_500_000_000;

describe("Command Code quota: the real recorded answer", () => {
  test("reads all three windows from the bodies the endpoint actually sent", () => {
    const quota = parseCommandCodeLimits(REAL_CREDITS, REAL_SUBSCRIPTION, AT);
    expect(quota).not.toBeNull();
    if (quota === null) return;

    expect(quota.fiveHour?.used).toBeCloseTo(0.4640194272, 9);
    expect(quota.fiveHour?.cap).toBe(14);
    expect(quota.fiveHour?.resetsAt).toBe(1795525232195);
    expect(quota.fiveHour?.percentUsed).toBeCloseTo((0.4640194272 / 14) * 100, 9);

    expect(quota.weekly?.used).toBeCloseTo(0.4850971734, 9);
    expect(quota.weekly?.cap).toBe(35);
    expect(quota.weekly?.resetsAt).toBe(1796074101408);

    // Monthly is what is LEFT of the plan's pool, so 70 - 69.51 spent.
    expect(quota.monthlyPool).toBe(70);
    expect(quota.monthlyRemaining).toBeCloseTo(69.5149028266, 9);
    expect(quota.monthly?.used).toBeCloseTo(70 - 69.5149028266, 9);
    expect(quota.monthly?.cap).toBe(70);
    expect(quota.monthly?.resetsAt).toBe(Date.parse("2026-12-23T21:07:01.000Z"));
    expect(quota.plan).toBe("individual-goat");
  });
});

describe("Command Code quota properties", () => {
  test("every percent stays inside 0..100 for any spend, including negative and absurd ones", () => {
    const caps = [0, 1, 14, 35, 70];
    const spends = [-1000, -0.001, 0, 0.5, 3.5, 14, 35, 70, 1e6];
    for (const cap of caps) {
      for (const used of spends) {
        const body = {
          credits: { monthlyCredits: Math.max(0, cap - used) },
          windowLimits: {
            fiveHour: { used, cap, resetAt: 1 },
            weekly: { used, cap, resetAt: 2 },
          },
        };
        const quota = parseCommandCodeLimits(body, { data: { planId: "individual-goat" } }, AT);
        expect(quota).not.toBeNull();
        for (const w of [quota?.fiveHour, quota?.weekly, quota?.monthly]) {
          if (w === null || w === undefined) continue;
          expect(w.percentUsed).toBeGreaterThanOrEqual(0);
          expect(w.percentUsed).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  test("a larger spend never lowers a window's percent", () => {
    let previous = -1;
    for (const used of [0, 0.1, 1, 7, 13.9, 14]) {
      const quota = parseCommandCodeLimits(
        { windowLimits: { fiveHour: { used, cap: 14, resetAt: 1 } } },
        null,
        AT
      );
      const percent = quota?.fiveHour?.percentUsed ?? -1;
      expect(percent).toBeGreaterThanOrEqual(previous);
      previous = percent;
    }
  });

  test("the monthly window is null when the plan is unknown, never a guessed pool", () => {
    const quota = parseCommandCodeLimits(REAL_CREDITS, { data: { planId: "individual-mystery" } }, AT);
    expect(quota).not.toBeNull();
    expect(quota?.monthly).toBeNull();
    expect(quota?.fiveHour).not.toBeNull();
  });

  test("a missing window is null, and the others still read", () => {
    const quota = parseCommandCodeLimits({ windowLimits: { weekly: { used: 1, cap: 35 } } }, null, AT);
    expect(quota).not.toBeNull();
    expect(quota?.fiveHour).toBeNull();
    expect(quota?.weekly?.used).toBe(1);
    expect(quota?.monthly).toBeNull();
  });

  test("a body carrying no window at all yields null, not zeros", () => {
    expect(parseCommandCodeLimits({}, null, AT)).toBeNull();
    expect(parseCommandCodeLimits(null, null, AT)).toBeNull();
    expect(parseCommandCodeLimits("nonsense", 42, AT)).toBeNull();
    expect(parseCommandCodeLimits({ windowLimits: { fiveHour: { cap: 14 } } }, null, AT)).toBeNull();
  });

  test("a missing reset time is null rather than 1970", () => {
    const quota = parseCommandCodeLimits({ windowLimits: { fiveHour: { used: 1, cap: 14 } } }, null, AT);
    expect(quota?.fiveHour?.resetsAt).toBeNull();
  });

  test("an ISO reset time is accepted as well as epoch ms", () => {
    const quota = parseCommandCodeLimits(
      { windowLimits: { fiveHour: { used: 1, cap: 14, resetAt: "2026-11-24T15:00:00Z" } } },
      null,
      AT
    );
    expect(quota?.fiveHour?.resetsAt).toBe(Date.parse("2026-11-24T15:00:00Z"));
  });

  test("the plan table matches the vendor CLI's own numbers", () => {
    expect(planPool("individual-go")).toBe(10);
    expect(planPool("individual-go-v1")).toBe(10);
    expect(planPool("individual-goat")).toBe(70);
    expect(planPool("individual-pro")).toBe(30);
    expect(planPool("individual-pro-v1")).toBe(80);
    expect(planPool("individual-provider")).toBe(15);
    expect(planPool("individual-max")).toBe(150);
    expect(planPool("individual-ultra")).toBe(300);
    expect(planPool("teams-pro")).toBe(40);
    expect(planPool(null)).toBeNull();
    expect(planPool("")).toBeNull();
    expect(planPool("enterprise")).toBeNull();
  });

  test("a spent-out month reads 100% and is marked exceeded", () => {
    const quota = parseCommandCodeLimits(
      { credits: { monthlyCredits: 0 }, windowLimits: { fiveHour: { used: 0, cap: 14 } } },
      { data: { planId: "individual-goat" } },
      AT
    );
    expect(quota?.monthly?.percentUsed).toBe(100);
    expect(quota?.monthly?.exceeded).toBe(true);
  });
});
