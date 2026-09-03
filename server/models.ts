/**
 * The model registry — the ONE home for what can be picked and what runs it.
 *
 * Until 2026-09-01 the list lived twice: `MODELS` in `input.ts` and a hand-written block of
 * `<option>` elements in `client/index.html`. Adding fifteen Google entries to both was the moment
 * that stopped being tolerable, so the list moved here and the client reads it from the server
 * (`GET /api/models`). A model that is not in this file cannot be picked, cannot reach argv, and
 * cannot spawn anything.
 *
 * Two runners, and the difference is not cosmetic. `claude` is the Anthropic CLI loom has always
 * driven. `agy` is Google's Antigravity CLI on User's AI Pro subscriptions — a different binary,
 * a different stdin message shape, different output frames, and a conversation id it mints itself.
 * What they share is the shape loom needs: one long-lived child, NDJSON in, stream-json out, one
 * turn per message. Verified by hand on 2026-09-01, before any of this was written.
 *
 * Ids carry the account on purpose. A second subscription served the same `gemini-3.7-flash-high`,
 * so the pickable id is `g1:gemini-3.7-flash-high` while `arg` holds the bare name that goes on the
 * command line. That account is gone (see GoogleAccount below), but the prefix stays: without it a
 * pick could not say which subscription it meant to spend.
 */

export type Family = "claude" | "google";
export type RunnerKind = "claude" | "agy";
/**
 * One account, not two. `user@example.com` carried the second AI Pro subscription and Google
 * disabled it on 2026-09-02 — "created or used with multiple other accounts to violate Google's
 * policies" — about five hours after it first answered. User's call the same day: take it out of
 * agy and out of loom rather than leave two dead pools drawing empty meters.
 *
 * The machinery for a second account is deliberately still here: the type is a union of one, the
 * account list is a list, and `agy.sh` still takes `AGY_PROFILE`. Adding an account back is one
 * entry in `GOOGLE_ACCOUNTS` and one sign-in.
 */
export type GoogleAccount = string;
export type GooglePool = "gemini" | "thirdparty";

export interface ModelSpec {
  /** What the client sends and what a session's pick stores. Unique across the registry. */
  id: string;
  /** What the dropdown shows inside its group. */
  label: string;
  /** The `<optgroup>` this belongs to. */
  group: string;
  family: Family;
  runner: RunnerKind;
  /** The value passed to `--model`. Absent means send no flag — the CLI's own default stands. */
  arg?: string;
  /** Google only: which subscription pays, and which of its two budgets. */
  account?: GoogleAccount;
  pool?: GooglePool;
}

const GEMINI = [
  "3.7-flash-high",
  "3.7-flash-medium",
  "3.7-flash-low",
  "3.6-flash-high",
  "3.6-flash-medium",
  "3.6-flash-low",
  "3.1-pro-high",
  "3.1-pro-low",
] as const;

const THIRD_PARTY = ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"] as const;

/** `key` is what an id and a budget are prefixed with; `account` is the Google login behind it. */
export const GOOGLE_ACCOUNTS: ReadonlyArray<{ key: "g1" | "g2"; account: GoogleAccount }> = [
  { key: "g1", account: Bun.env["LOOM_GOOGLE_ACCOUNT"] ?? "google-account-1" },
];

function googleModels(): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const { key, account } of GOOGLE_ACCOUNTS) {
    for (const suffix of GEMINI) {
      const arg = `gemini-${suffix}`;
      out.push({
        id: `${key}:${arg}`,
        label: arg,
        group: `google · ${account} · gemini`,
        family: "google",
        runner: "agy",
        arg,
        account,
        pool: "gemini",
      });
    }
    for (const arg of THIRD_PARTY) {
      out.push({
        id: `${key}:${arg}`,
        label: arg,
        group: `google · ${account} · third-party`,
        family: "google",
        runner: "agy",
        arg,
        account,
        pool: "thirdparty",
      });
    }
  }
  return out;
}

export const MODEL_SPECS: readonly ModelSpec[] = [
  { id: "default", label: "default", group: "claude code", family: "claude", runner: "claude" },
  { id: "opus", label: "opus", group: "claude code", family: "claude", runner: "claude", arg: "opus" },
  { id: "sonnet", label: "sonnet", group: "claude code", family: "claude", runner: "claude", arg: "sonnet" },
  { id: "haiku", label: "haiku", group: "claude code", family: "claude", runner: "claude", arg: "haiku" },
  { id: "fable", label: "fable", group: "claude code", family: "claude", runner: "claude", arg: "fable" },
  ...googleModels(),
];

/** Every pickable id, in dropdown order. The allowlist `asModelId` checks against. */
export const MODEL_IDS: readonly string[] = MODEL_SPECS.map((m) => m.id);

const BY_ID = new Map<string, ModelSpec>(MODEL_SPECS.map((m) => [m.id, m]));

const FALLBACK = MODEL_SPECS[0] as ModelSpec;

/** Anything not on the list degrades to "default" — a bad pick must not break a send. */
export function asModelId(value: unknown): string {
  return typeof value === "string" && BY_ID.has(value) ? value : "default";
}

export function specFor(id: string): ModelSpec {
  return BY_ID.get(id) ?? FALLBACK;
}

export function familyOf(id: string): Family {
  if (id.startsWith("g1:") || id.startsWith("g2:") || id.startsWith("gemini-") || /^g\d+:/.test(id)) {
    return "google";
  }
  return specFor(id).family;
}

export function runnerOf(id: string): RunnerKind {
  return specFor(id).runner;
}

/**
 * The budgets the limits bar draws: Anthropic's own window, the two pools on the Google account,
 * and Jules' daily task count. Ids are stable — the client keys its meters off them.
 */
export const BUDGET_IDS = ["anthropic", "g1:gemini", "g1:thirdparty", "jules"] as const;

export type BudgetId = (typeof BUDGET_IDS)[number];

/** Which budget a session on this model is spending. */
export function budgetFor(id: string): BudgetId {
  const spec = specFor(id);
  if (spec.family === "claude") return "anthropic";
  return `g1:${spec.pool ?? "gemini"}` as BudgetId;
}
