/** The client's shared shapes — every type `app.ts` used to declare inline.
 *
 * They live here so a module can take the shapes it needs without importing the entry point, which
 * is what a type declared inside `app.ts` forces and what makes every further split a cycle. Types
 * only: no state, no DOM, no runtime. Split out 2026-08-24 from `app.ts` at 5,983 lines.
 */
import type { Message, MessageUsage } from "./render.ts";
import type { Hypothesis } from "./hypotheses.ts";
import type { Task } from "./tasks.ts";
import type { ProtoFile } from "./protos.ts";

// `Message` already carries `usage?: MessageUsage` (usage-bar, 2026-08-26) — re-exported here so a
// module reaching for shared shapes finds it without reaching into `render.ts` directly, the same
// reason this file exists at all (see header comment).
export type { MessageUsage };

export interface ProjectInfo {
  key: string;
  cwd: string | null;
  label: string;
  sessions: number;
  lastActive: number;
}

export interface ModelSpec {
  id: string;
  label: string;
  group: string;
  family: "claude" | "google";
  runner: "claude" | "agy";
  arg?: string;
  account?: string;
  pool?: "gemini" | "thirdparty";
}

export interface SessionPick {
  model: string;
  effort: string;
  mode: "auto" | "cards";
  at: number;
}

export interface SessionInfo {
  id: string;
  /** Absolute path of the transcript. Self-describing, so the store it lives in never has to be
   *  guessed from the record's directory — which is what broke once sessions moved into cores. */
  file: string;
  bytes: number;
  mtime: number;
  startedAt: number;
  title: string | null;
  firstPrompt: string | null;
  gitBranch: string | null;
  pick: SessionPick | null;
  family: "claude" | "google";
}

/** The transcript's own token accounting for one session — measured, never predicted (SPEC §Train). */
export interface CacheState {
  at: number;
  context: number;
  reuse: number;
  ttlMs: number | null;
}

export interface TrainCar extends SessionInfo {
  cache: CacheState | null;
}

export interface Train {
  record: string;
  cwd: string;
  key: string | null;
  cars: TrainCar[];
}

/** What `/api/activity` says about one session — the raw material of the tree's marks (SPEC 62). */
export interface SessionActivity {
  id: string;
  /** The transcript store the file sits in — what the socket is addressed by (SPEC 234). */
  store: string;
  mtime: number;
  lastReply: number;
  /** The newest reply that ENDED its turn — what the letter is drawn on (SPEC 111). */
  lastEnded: number;
  lastTyped: number;
  /**
   * The prompt-cache window, as the two numbers it is: when the last API call landed, and the
   * bucket it wrote into (SPEC 259). Null when the transcript tail stated none — a row with no bar,
   * never a guessed hour. Optional on the wire so an older server cannot blank the tree.
   */
  cacheAt?: number | null;
  ttlMs?: number | null;
  /** A turn is producing output here right now (SPEC 260). */
  running?: boolean;
}

export interface Artifact {
  path: string;
  name: string;
  kind: "read" | "write" | "edit";
  ops: string[];
  count: number;
  lastTs: string;
  msgUuids: string[];
}

export interface Pin {
  note: string | null;
  ts: string;
}

export interface Permit {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  ts: string;
}

export interface RecordRef {
  path: string;
  why: string | null;
}

export interface RecordInfo {
  path: string;
  title: string;
  status: string;
  created: string | null;
  parent: string | null;
  references: RecordRef[];
  mtime: number;
  /** Which core owns this record — tagged by the server, never derived here. */
  core: string;
}

/** A record split for rendering, in file order: prose, claims, prose, work items, prose. */
export interface RecordDoc {
  head: string;
  hypotheses: Hypothesis[];
  middle: string;
  tasks: Task[];
  tail: string;
}

/**
 * One message the server is holding for a session: accepted, not yet answered (SPEC 138). `at` is
 * the server's own accept time, and it is what the echo is POSITIONED by — the transcript is in time
 * order, so an echo belongs wherever its accept time falls in it, not at the end of the page.
 */
export interface PendingEcho {
  text: string;
  at: number;
}

export type Frame =
  | {
      type: "full";
      meta: { cwd: string | null; title: string | null; gitBranch: string | null };
      messages: Message[];
      artifacts: Artifact[];
      skipped: number;
      pins: Record<string, Pin>;
      /** Every send's accept time — the queue's memory after the queue forgets (SPEC 145). */
      accepts?: PendingEcho[];
    }
  | { type: "append"; messages: Message[]; artifacts: Artifact[] }
  | { type: "permits"; permits: Permit[] }
  | {
      type: "job";
      state: "running" | "done" | "error";
      detail: string | null;
      queued?: number;
      /** The queue's own contents, oldest first — what the echoes are drawn from (SPEC 138). */
      pending?: PendingEcho[];
      /** The act in flight, already quieted server-side (SPEC 96). */
      step?: string | null;
      /** How long that act had been the shown label when the server sent this. */
      stepMs?: number;
    }
  | {
      /** The previous session, carried across the seam (SPEC §Recap). Not a message: it arrives on
       *  its own frame, generates no turn, and is drawn above the transcript. */
      type: "recap";
      phase: "running" | "ready" | "failed" | "none";
      entry: RecapEntry | null;
      reason: string | null;
      /** ISO time the run started — the clock's zero when the screen attached after it (181). */
      startedAt?: string | null;
    }
  | { type: "error"; message: string }
  | {
      type: "subagent";
      agentId: string;
      description: string | null;
      agentType: string | null;
      elapsedS: number;
      lastActivityTs: string | null;
      idleS: number;
      lastLabel: string | null;
      rowCount: number;
      ownEndTurn: boolean;
      verdict: "RUNNING" | "FINISHED" | "STALE / POSSIBLY DEAD" | "DEAD";
      isBackground: boolean;
    };

export interface RecapEntry {
  sessionId: string;
  title: string;
  writtenAt: string;
  atTurn: number;
  supersedes: string | null;
  body: string;
}

export interface ProtoGroup {
  record: string;
  title: string;
  files: ProtoFile[];
}

/** Mirrors `Severity` in server/usage.ts. */
export type Severity = "normal" | "warning" | "critical";

/** Mirrors `QuotaWindow` in server/usage.ts. */
export interface QuotaWindow {
  percent: number;
  resetsAt: number | null;
  severity: Severity;
}

/** Mirrors `ScopedWindow` in server/usage.ts. */
export interface ScopedWindow {
  label: string;
  percent: number;
  resetsAt: number | null;
}

/** Mirrors `Quota` in server/usage.ts — the account's own reading, never the fitted estimate. */
export interface Quota {
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  scoped: ScopedWindow[];
  at: number;
}

/** What `/api/bar` returns. Mirrors `BarReading` in server/bar.ts. */
export interface BarReading {
  quota: Quota | null;
  stale: boolean;
  scale: number;
  block: { start: number; end: number; units: number };
  session: { units: number; percent: number } | null;
}
