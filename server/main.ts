/**
 * The whole server. Bun.serve bundles the client on demand (no build step) and holds one Watcher per
 * open session.
 *
 * SPEC invariant 1 is enforced structurally here: transcript paths are CONSTRUCTED from a validated
 * project key + session id under PROJECTS_ROOT and are only ever read.
 *
 * `/api/file` is the single exception — it takes a path, because the file pane exists — and every
 * such path passes the allow-root guard in `files.ts` before anything is opened.
 */

import { dirname, join, resolve as resolvePath } from "node:path";
import index from "../client/index.html";
import { PROJECTS_ROOT, listProjects } from "./projects.ts";
import { AGY_PROJECTS_ROOT } from "./agy.ts";
import { listSessions, listSessionsForProject, transcriptPath, attachPicks } from "./sessions.ts";
import type { SessionInfo } from "./sessions.ts";
import { Tailer } from "./tail.ts";
import { aggregate, type Message, type Touch } from "./transcript.ts";
import { readPins, setPin, type PinMap } from "./pins.ts";
import { addAccept, readAccepts, type Accept } from "./accepts.ts";
import { openPath } from "./open.ts";
import { MAX_BYTES, truncateUtf8, guardFrom, kindOf, listDir, locate, looksBinary, resolveWiki, wikiScope } from "./files.ts";
import { stat } from "node:fs/promises";
import { readFileSync, type Stats } from "node:fs";
import { PermitBroker, type Permit, type Verdict } from "./permits.ts";
import { MODEL_SPECS, asModelId } from "./models.ts";
import { writePick, readAllPicks } from "./picks.ts";
import { asEffort, asModel, Runner, type JobEvent, type JobState, type QueuedMessage } from "./input.ts";
import { authed, loadToken, loginResponse } from "./auth.ts";
import { frameOf, scanRecords, scanRecordsUncached, recordsWithStaleness, type RecordInfo } from "./records.ts";
import { CORES, cwdFor, homeFor, usableCores } from "./cores.ts";
import { homedir, hostname } from "node:os";
import { readAskRules } from "./askrules.ts";
import { compactLinks, mergeByLink, readLinks, sessionsOf, writeLink } from "./links.ts";
import {
  addTask,
  createRecord,
  parseRecord,
  promoteTask,
  renameRecord,
  addReference,
  setResult,
  setStatus,
  setStanding,
  setTitle,
  writeAtomic,
  STANDINGS,
  STATUSES,
  type Standing,
  type TaskStatus,
} from "./tasks.ts";
import { setProjectStatus, setVerdict, PROJECT_STATUSES, type ProjectStatus } from "./lifecycle.ts";
import { answerRecords, activityOf, listActivityForDirs, type SessionActivity } from "./activity.ts";
import { findIntroduction, listPrototypes } from "./protos.ts";
import { readBarReading } from "./bar.ts";
import { readCurrentBudgets } from "./budgets.ts";
import { buildState } from "./build-state.ts";
import { assembleTrainFor, storeKeyOf, type Train } from "./train.ts";
import {
  claimWarm,
  dismiss,
  dropWarm,
  peekWarm,
  appendEntry,
  readDismissals,
  readLedger,
  recapForNewSession,
  reminderFor,
  restorableFor,
  warmFinish,
  warmRunning,
  warmStart,
  type RecapPhase,
  type RecordStore,
} from "./recap/service.ts";
import type { Entry as RecapEntry } from "./recap/ledger.ts";
import { readAll as readSeen, writeOwn as writeSeen } from "./seen.ts";
import { readDraft, writeDraft } from "./drafts.ts";
import { SubagentWatcher } from "./subagent-watcher.ts";
import { createTask, julesClientOrNull, listTasks, readTask, startPolling } from "./jules/service.ts";
import { isTerminalState } from "./jules/parser.ts";

/**
 * A session worktree's server binds ITS OWN port, whoever starts it and whatever it inherits
 * (SPEC 153).
 *
 * `loom.service` sets `LOOM_PORT=4173`, and loom spawns the Claude sessions — so every shell inside
 * a worktree inherits the STABLE port, and both `run.sh` and a bare `bun server/main.ts` bound
 * 4173 beside the systemd instance. Two servers, two device tokens, and about half of User's
 * requests rejected as "wrong token": he was logged out of his own loom mid-build (2026-08-10).
 * The tree-specific marker therefore beats the inherited variable, which is a global default.
 */
function sessionPort(): number | null {
  try {
    const marker = readFileSync(join(import.meta.dir, "..", "..", "..", ".session"), "utf8");
    const found = /^port=(\d+)$/m.exec(marker);
    return found?.[1] !== undefined ? Number(found[1]) : null;
  } catch {
    return null; // the main tree has no marker, and keeps 4173
  }
}

/**
 * An EXPLICIT port wins; the marker only overrules the STABLE one.
 *
 * "Marker beats environment" was too broad: the pins harness sets `LOOM_PORT` to its own slot, and
 * the marker overruled that too, so the journey server bound the dev port and Playwright waited 60s
 * for a server that was answering somewhere else. The failure this guards is narrower than that —
 * `loom.service` exports 4173 and loom spawns the sessions, so 4173 is the one value that arrives
 * by inheritance rather than by intent.
 */
const asked = Number(Bun.env["LOOM_PORT"] ?? 0);
const marked = sessionPort();
const PORT = marked !== null && (asked === 0 || asked === 4173) ? marked : asked || 4173;
const STATE_DIR = Bun.env["LOOM_STATE"] ?? join(import.meta.dir, "..", "state");
/**
 * Where the session→project LINKS live — pinned, for the same reason `cores.ts` pins the vault.
 *
 * `STATE_DIR` hangs off `import.meta.dir`, so every worktree and every pin slot owns a different
 * `links.json`. That is right for the rest of state — a canary's drafts and dismissals are its own —
 * and wrong for a link, which is not a preference but a fact about the world: this session belongs
 * to this project. A session started from a worktree instance wrote its link into that checkout's
 * state, and the service on 4173 then read a file that had never heard of it, so the session showed
 * as belonging nowhere. Nothing had deleted it — `writeLink` is the only writer and is purely
 * additive — which is why it read as a session "detaching by itself" (User, 2026-08-17).
 *
 * `LOOM_STATE` still wins where it is set, so every test slot stays isolated exactly as before.
 */
const LINKS_DIR =
  Bun.env["LOOM_LINKS"] ??
  Bun.env["LOOM_STATE"] ??
  "/home/user/resilio/docs/Projects/Personal Claude/tools/loom/state";
// Boot, before the first request: migrates an old whole-object links.json to the append-only
// shape unconditionally, and folds an already-new-shape log once it has grown past its threshold —
// see `compactLinks`'s doc comment in links.ts. `writeLink` only ever appends, so the very first
// write in this process's lifetime must not land on an unmigrated file (item 55).
await compactLinks(LINKS_DIR);

const initialJulesTasks = await listTasks(STATE_DIR);
const julesClient = julesClientOrNull(join(import.meta.dir, "..", "..", "jules"));
if (julesClient !== null) {
  for (const task of initialJulesTasks) {
    if (!isTerminalState(task.state)) {
      startPolling(
        STATE_DIR,
        task.id,
        (t) => broadcastToSession(t.loomSession, { type: "jules", task: t }),
        (id) => julesClient.getSession(id)
      );
    }
  }
}

/**
 * Sessions this process has already settled the link question for — the adoption check below reads
 * links.json once per resumed session, never once per send.
 */
const adopted = new Set<string>();
// Outside the transcript store on purpose (requirement 177): the CLI derives a store slug from its
// child's cwd, and `assembleTrain` lists every .jsonl in a store as a car. A recap child spawned in
// the record's directory would appear in the session picker as a session nobody started.
const RECAP_SCRATCH = join(STATE_DIR, "recap-agent");
/**
 * The last recap frame per session, replayed when a socket attaches.
 *
 * A broadcast alone cannot work here: `beginNewSession` blanks the session id and connects with an
 * EMPTY one, so at the moment the recap becomes ready the new session has no socket at all — the
 * client only attaches after `adoptNewSession` polls it up, seconds after the first send. A frame
 * sent into that gap goes nowhere, which is exactly what the driven pin caught. Same shape as the
 * job frame above: the server owns the state, and attaching replays it.
 */
const lastRecap = new Map<string, Frame>();

/** One shape for the block, whichever of the three paths produced the recap. */
function recapFrame(entry: RecapEntry | null, reason: string | null): Extract<Frame, { type: "recap" }> {
  if (entry !== null) return { type: "recap", phase: "ready", entry, reason: null, startedAt: null };
  if (reason !== null) return { type: "recap", phase: "failed", entry: null, reason, startedAt: null };
  return { type: "recap", phase: "none", entry: null, reason: null, startedAt: null };
}

/** Put it on his screen and remember it for a socket that has not attached yet. Never carries. */
function deliverRecap(sessionId: string, entry: RecapEntry | null, reason: string | null): void {
  const frame = recapFrame(entry, reason);
  if (frame.phase === "none") lastRecap.delete(sessionId);
  else lastRecap.set(sessionId, frame);
  broadcastToSession(sessionId, frame);
}

const ROOT = Bun.env["LOOM_PROJECTS_ROOT"] ?? PROJECTS_ROOT;
const AGY_ROOT = Bun.env["LOOM_AGY_PROJECTS_ROOT"] ?? AGY_PROJECTS_ROOT;
const POLL_MS = Number(Bun.env["LOOM_POLL_MS"] ?? 500);
const CLAUDE_BIN = Bun.env["LOOM_CLAUDE_BIN"] ?? "claude";
const PERMIT_TIMEOUT_MS = Number(Bun.env["LOOM_PERMIT_TIMEOUT_MS"] ?? 30 * 60 * 1000);

// server → loom → tools → Personal Claude → Projects → the vault root.
const VAULT_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const GUARD = guardFrom(Bun.env["LOOM_ROOTS"], VAULT_ROOT, Bun.env["LOOM_ALIASES"]);

// Project records live under the vault's Projects/ (which contains this repo, and so toys/ too).
const RECORD_ROOTS = (Bun.env["LOOM_RECORD_ROOTS"] ?? join(VAULT_ROOT, "Projects"))
  .split(":")
  .filter((r) => r.length > 0);

const SAFE = /^[A-Za-z0-9._-]+$/;

interface SocketData {
  watchKey: string;
}

type Frame =
  | { type: "draft"; key: string; text: string; at: number }
  | {
      type: "full";
      meta: unknown;
      messages: Message[];
      artifacts: unknown;
      skipped: number;
      pins: PinMap;
      /** Every send's accept time, so a queued message keeps its place once answered (SPEC 145). */
      accepts: Accept[];
    }
  | { type: "append"; messages: Message[]; artifacts: unknown }
  | { type: "permits"; permits: Permit[] }
  | {
      type: "job";
      state: JobState;
      detail: string | null;
      queued: number;
      pending: QueuedMessage[];
      step: string | null;
      stepMs: number;
    }
  | {
      /** The previous session, carried across the seam (SPEC §Recap). Never a message: the block is
       *  UI and context, so it arrives on its own frame and generates no turn. */
      type: "recap";
      phase: "running" | "ready" | "failed" | "none";
      entry: unknown;
      reason: string | null;
      /** When the run started, so a screen that attaches mid-run counts from zero, not from now
       *  (requirement 181). Only ever set on `running`. */
      startedAt: string | null;
    }
  | { type: "jules"; task: unknown }
  | { type: "error"; message: string };

class Watcher {
  private readonly sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tailer: Tailer;
  private touches: Touch[] = [];
  private subagentWatcher: SubagentWatcher | null = null;

  constructor(
    readonly key: string,
    readonly path: string,
    // Takes the watcher, not just the key: a watcher that empties late must never evict whatever
    // holds its key NOW. See the identity check at the call site.
    private readonly onEmpty: (watcher: Watcher) => void,
  ) {
    this.tailer = new Tailer(path);
    const sessionId = path.split("/").pop()?.replace(".jsonl", "") ?? "";
    if (sessionId) {
      this.subagentWatcher = new SubagentWatcher(
        dirname(path),
        (frame: any) => {
          for (const s of this.sockets) this.send(s, frame);
        },
        runner,
        sessionId
      );
      this.subagentWatcher.start();
    }
  }

  /**
   * Claim the socket for this watcher, synchronously, before anything can await.
   *
   * A reload closes the old socket and opens a new one within a few milliseconds of each other, and
   * `open` has to read pins and accepts off disk before it can `attach`. Registering only in
   * `attach` left a gap: the outgoing socket's `close` could land inside it, empty the watcher and
   * drop it from `watchers`, and the incoming socket then attached to a watcher nobody could find.
   * That page kept its own tailer — so the transcript still grew — but `broadcastToSession` walks
   * `watchers`, so no `job` and no `permits` frame ever reached it again. The visible end of it was
   * a working row and a stop button that never went away, because only a `job` frame clears them.
   *
   * `open` is synchronous up to this call, so both orderings are now safe: a close before it drops
   * the watcher and the next open builds a fresh one, and a close after it finds a set that is not
   * empty. Measured before the fix: 16 attaches onto a dropped watcher in one pin suite.
   */
  hold(socket: Bun.ServerWebSocket<SocketData>): void {
    this.sockets.add(socket);
  }

  async attach(socket: Bun.ServerWebSocket<SocketData>, pins: PinMap, accepts: Accept[]): Promise<void> {
    this.sockets.add(socket);
    await this.tailer.poll();
    const model = this.tailer.transcript.model();
    this.touches = [...model.touches];
    this.send(socket, {
      type: "full",
      meta: model.meta,
      messages: model.messages,
      artifacts: aggregate(this.touches),
      skipped: model.skipped,
      pins,
      accepts,
    });
    if (this.timer === null) this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  detach(socket: Bun.ServerWebSocket<SocketData>): void {
    this.sockets.delete(socket);
    if (this.sockets.size > 0) return;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.subagentWatcher?.stop();
    this.onEmpty(this);
  }

  private async tick(): Promise<void> {
    let event: Awaited<ReturnType<Tailer["poll"]>>;
    try {
      event = await this.tailer.poll();
    } catch {
      return; // a transient read failure is not fatal; the next tick retries
    }
    if (event === null) return;

    const parser = this.tailer.transcript;
    if (event.kind === "full") {
      const model = parser.model();
      this.touches = [...model.touches];
      this.broadcast({
        type: "full",
        meta: model.meta,
        messages: model.messages,
        artifacts: aggregate(this.touches),
        skipped: model.skipped,
        pins: {},
        // A re-read of the same file changes no accept time, and the client MERGES rather than
        // replaces — so an empty list here costs a message nothing (SPEC 145).
        accepts: [],
      });
      return;
    }

    const slice = parser.since(event.fromMessage, event.fromTouch);
    if (slice.messages.length === 0 && slice.touches.length === 0) return;
    this.touches.push(...slice.touches);
    this.broadcast({
      type: "append",
      messages: slice.messages,
      // Aggregation is over the whole set: a new read of an already-written file changes its row.
      artifacts: aggregate(this.touches),
    });
  }

  private send(socket: Bun.ServerWebSocket<SocketData>, frame: Frame): void {
    socket.send(JSON.stringify(frame));
  }

  /** Out-of-band frames (permits, job status) share the session's socket set. */
  broadcastFrame(frame: Frame): void {
    this.broadcast(frame);
  }

  private broadcast(frame: Frame): void {
    const payload = JSON.stringify(frame);
    for (const socket of this.sockets) socket.send(payload);
  }
}

const watchers = new Map<string, Watcher>();
// Every live socket, so a test can sever them all at once — the only way to DRIVE the client's
// reconnect path, since a pin cannot put the laptop to sleep.
const liveSockets = new Set<Bun.ServerWebSocket<SocketData>>();

function sessionTranscriptPath(projectKey: string, sessionId: string): string | null {
  return transcriptPath(projectKey, sessionId, ROOT, AGY_ROOT);
}

/**
 * A NOTE ON WHAT WAS TRIED HERE AND REVERTED, 2026-08-20 (SPEC 227).
 *
 * To let the client open the socket straight from the address, the server was made to FIND the
 * session: if the named store did not hold it, scan the stores for one that did. It works, and it
 * is wrong. The pair `(project, session)` in an address is a claim, and the 404 is what tells the
 * client the claim is stale — resolve it away and a stale session id in the URL quietly serves a
 * real transcript from somewhere else, which is a reader looking at one session with another's name
 * on the tab. Eleven pins failed on exactly that, all of them showing the picker naming one session
 * and the transcript showing another.
 *
 * The client asks with a store it is sure of instead: it fetches the session list first, which is
 * one request rather than the six it used to queue behind.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Watcher keys are `<projectKey>/<sessionId>`; permit and job frames are addressed by session. */
function broadcastToSession(sessionId: string, frame: Parameters<Watcher["broadcastFrame"]>[0]): void {
  for (const [key, watcher] of watchers) {
    if (key.endsWith(`/${sessionId}`)) watcher.broadcastFrame(frame);
  }
}

/** Identifies this run of the server. A client comparing it against its own tells staleness. */
const BUILD = `${Math.floor(Date.now() / 1000).toString(36)}`;

const broker = new PermitBroker(
  (sessionId) => broadcastToSession(sessionId, { type: "permits", permits: broker.forSession(sessionId) }),
  PERMIT_TIMEOUT_MS,
);

const runner = new Runner(CLAUDE_BIN, `http://127.0.0.1:${PORT}/api/permit/ask`, PORT, (event: JobEvent) =>
  broadcastToSession(event.sessionId, {
    type: "job",
    state: event.state,
    detail: event.detail,
    queued: event.queued,
    pending: event.pending,
    step: event.step,
    stepMs: event.stepMs,
  }),
);

/**
 * Take back whatever the previous loom left running, before a single request is served (SPEC 255).
 * Keyed by PORT, so a worktree loom adopts only its own children and never the real one's.
 */
runner.adopt();

/**
 * His standing `permissions.ask` rules, read once (SPEC 219).
 *
 * The user settings file, not the project one: that is where his twelve rules live, and it is the
 * file the CLI itself would consult. `LOOM_ASK_SETTINGS` exists so a pin can hand this a fixture
 * instead of whatever the machine happens to have — a test that depends on the real settings file is
 * a test that changes meaning when he edits it.
 */
const ASK_SETTINGS = Bun.env["LOOM_ASK_SETTINGS"] ?? join(homedir(), ".claude", "settings.json");
void readAskRules(ASK_SETTINGS).then((rules) => {
  runner.setAskRules(rules);
  if (rules.length > 0) console.log(`[loom] ${rules.length} ask rules will raise a card`);
});

/**
 * SPEC 36: /api/permit/ask is loopback-only permanently — the hook always runs on
 * loom's machine, holds no token, and can only CREATE prompts, never approve them.
 */
function isLoopback(req: Request): boolean {
  const address = server.requestIP(req)?.address ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const TOKEN = await loadToken(STATE_DIR);

/** SPEC invariant 7: every data route requires the device token. Null means "carry on". */
function requireAuth(req: Request): Response | null {
  return authed(req, TOKEN, PORT) ? null : json({ error: "unauthenticated" }, 401);
}

// Both generics must be explicit: Bun.serve<WebSocketData, RoutePaths>. Fixing the first without the
// second collapses RoutePaths to `never` and every req.params access loses its type.
type Routes =
  | "/api/draft"
  | "/api/recap"
  | "/api/recap/dismiss"
  | "/api/recap/rerun"
  | "/api/recap/warm"
  | "/"
  | "/login"
  | "/manifest.webmanifest"
  | "/icon.svg"
  | "/icon-192.png"
  | "/icon-512.png"
  | "/sw.js"
  | "/api/build"
  | "/api/projects"
  | "/api/projects/:key/sessions"
  | "/api/records/sessions"
  | "/api/cores"
  | "/api/projects/:key/sessions/:id/pins"
  | "/api/pin"
  | "/api/file"
  | "/api/interrupt"
  | "/api/open"
  | "/api/models"
  | "/api/input"
  | "/api/permit/ask"
  | "/api/permit/answer"
  | "/api/plan-state"
  | "/api/records"
  | "/api/roots"
  | "/api/record"
  | "/api/record/task"
  | "/api/record/add"
  | "/api/record/hypothesis"
  | "/api/record/status"
  | "/api/record/promote"
  | "/api/record/create"
  | "/api/record/rename"
  | "/api/record/reference"
  | "/api/prototypes"
  | "/api/prototypes/where"
  | "/api/activity"
  | "/api/bar"
  | "/api/budgets"
  | "/api/session-state"
  | "/api/test/drop-sockets"
  | "/api/test/retire"
  | "/api/jules"
  | "/api/jules/task"
  | "/api/train"
  | "/api/transcript"
  | "/api/seen";

/**
 * A record is addressed by its path, but only a path the SCAN produced — never a raw one. This is
 * what keeps the write routes below from becoming "edit any file you can name" on a LAN port; it is
 * the same rule `/api/input` uses to decide where a child may be spawned.
 */
async function knownRecord(path: unknown): Promise<RecordInfo | null> {
  if (typeof path !== "string") return null;
  const found = (await scanRecords(RECORD_ROOTS)).find((r) => r.path === path);
  if (found !== undefined) return found;
  // SPEC 231: a MISS is the one answer the cache must not give from memory. A deep link, a spawn
  // request or a rail row can name a record another process wrote to disk seconds ago, and "no such
  // project record" would then be wrong rather than merely stale. A hit is always safe to serve
  // cached — the record exists; only its absence needs the walk to confirm it.
  return (await scanRecordsUncached(RECORD_ROOTS)).find((r) => r.path === path) ?? null;
}

/**
 * Where one record's sessions live (SPEC 217) — the two-source answer `/api/train` and
 * `/api/records/sessions` already use, in one place so a third surface cannot re-derive it wrongly.
 *
 * `recordPath === null` is a session loom drives with no record behind it: its own escaped cwd is
 * both stores and there is nothing to link, which is the pre-cores behaviour and what the fixtures
 * run under.
 */
async function storeFor(recordPath: string | null, fallbackCwd: string): Promise<RecordStore> {
  if (recordPath === null) {
    const dir = join(ROOT, storeKeyOf(fallbackCwd));
    const agyDir = join(AGY_ROOT, storeKeyOf(fallbackCwd));
    return { ownDir: dir, coreDir: dir, linked: new Set<string>(), ownAgyDir: agyDir, coreAgyDir: agyDir };
  }
  const ownKey = storeKeyOf(dirname(recordPath));
  const coreKey = storeKeyOf(cwdFor(recordPath));
  return {
    ownDir: join(ROOT, ownKey),
    coreDir: join(ROOT, coreKey),
    ownAgyDir: join(AGY_ROOT, ownKey),
    coreAgyDir: join(AGY_ROOT, coreKey),
    linked: new Set(sessionsOf(recordPath, await readLinks(LINKS_DIR))),
  };
}

/**
 * The record a recap call is about, from the `record` parameter the client now sends.
 *
 * It used to send `cwd`, and that is the bug this replaces: the client's `state.cwd` is overwritten
 * by every session's `full` frame, so once a session was running the recap calls named the CORE
 * directory shared by every project under it. A record path cannot drift that way — it names one
 * project and one ledger.
 */
async function recapTargetOf(path: unknown): Promise<{ dir: string; store: RecordStore } | null> {
  const record = await knownRecord(path);
  if (record === null) return null;
  return { dir: dirname(record.path), store: await storeFor(record.path, dirname(record.path)) };
}

/**
 * One record's-worth of activity, shared by the GET and the POST above so the two spellings of the
 * same question cannot drift apart.
 */
async function activityAnswer(req: Request, rawKeys: string, askedRecords: readonly string[]): Promise<Response> {
  const denied = requireAuth(req);
  if (denied !== null) return denied;
  const keys = [...new Set(rawKeys.split(",").filter((k) => k.length > 0 && SAFE.test(k)))].slice(0, 200);
  const wanted = [...new Set(askedRecords)].slice(0, 200);

  const known = wanted.length === 0 ? [] : await scanRecords(RECORD_ROOTS);
  const paths = new Set(known.map((r) => r.path));
  const links = wanted.length === 0 ? new Map<string, string>() : await readLinks(LINKS_DIR);
  const out: Record<string, SessionActivity[]> = {};
  // Resolved OFF the known-paths gate, keyed by record — `answerRecords` below is what turns this
  // into the `answered` field, so a record this loop never touched (a filter bug, SPEC 217's shape)
  // cannot end up silently claimed as answered either.
  const resolved = new Map<string, SessionActivity[]>();
  await Promise.all([
    ...keys.map(async (key) => {
      out[key] = await listActivityForDirs([join(ROOT, key), join(AGY_ROOT, key)]);
    }),
    ...wanted
      .filter((record) => paths.has(record))
      .map(async (record) => {
        const ownClaude = join(ROOT, storeKeyOf(dirname(record)));
        const ownAgy = join(AGY_ROOT, storeKeyOf(dirname(record)));
        const coreClaude = join(ROOT, storeKeyOf(cwdFor(record)));
        const coreAgy = join(AGY_ROOT, storeKeyOf(cwdFor(record)));
        const own = await listActivityForDirs([ownClaude, ownAgy]);
        if (ownClaude === coreClaude && ownAgy === coreAgy) {
          resolved.set(record, own);
          return;
        }
        // The link is what makes a session in the shared core store this record's.
        const ids = new Set(sessionsOf(record, links));
        const core = await listActivityForDirs([coreClaude, coreAgy]);
        resolved.set(record, mergeByLink(own, core, ids));
      }),
  ]);
  // A path the scan does not know answers empty rather than 404-ing the whole poll: the tree may
  // still be holding a record that was renamed or deleted under it, and one stale row must not
  // blank the marks on every other. `answerRecords` is what also keeps it OUT of `answered` — SPEC
  // requirement 237, so the client can tell "asked, and empty" from "never asked at all".
  const { data, answered } = answerRecords(wanted, paths, (record) => resolved.get(record) ?? []);
  Object.assign(out, data);
  // The two witnesses of "a turn is running here", unioned (SPEC 260, 267). `listActivity` has already
  // applied the transcript's own five-minute rule; this raises it for a child loom SPAWNED, which
  // is exact and stops within one poll, unless the runner is stale. Safe to mutate: `listActivity`
  // hands back fresh objects, never the ones its (mtime, size) memo holds.
  for (const list of Object.values(out)) {
    for (const session of list) {
      const newest = Math.max(session.lastReply, session.lastTyped);
      const transcriptSaysEnded = newest > 0 && session.lastEnded >= newest;
      if (!runner.stale(session.id, transcriptSaysEnded)) {
        if (!session.running && runner.running(session.id)) session.running = true;
      }
    }
  }
  return json({ ...out, answered });
}

const server = Bun.serve<SocketData, Routes>({
  port: PORT,
  // Two servers on one port is a silent split-brain, not a convenience: SO_REUSEPORT let a
  // worktree's server share 4173 with the real one and swallow half the requests (2026-08-10).
  reusePort: false,
  // Bun's hot-reload client calls location.reload() on every visibilitychange — it reloads the
  // page under the user's hands. loom has its own update bar (#update-bar, fed by /api/build).
  development: Bun.env["NODE_ENV"] === "production" ? false : { hmr: false, console: false },

  routes: {
    "/": index,

    "/login": (req) => loginResponse(req, TOKEN, PORT),

    // PWA shell files — tokenless like "/" itself: chrome, no data.
    "/manifest.webmanifest": () =>
      new Response(Bun.file(join(import.meta.dir, "..", "client", "manifest.webmanifest")), {
        headers: { "content-type": "application/manifest+json" },
      }),
    "/icon.svg": () =>
      new Response(Bun.file(join(import.meta.dir, "..", "client", "icon.svg")), {
        headers: { "content-type": "image/svg+xml" },
      }),
    "/icon-192.png": () =>
      new Response(Bun.file(join(import.meta.dir, "..", "client", "icon-192.png")), {
        headers: { "content-type": "image/png" },
      }),
    "/icon-512.png": () =>
      new Response(Bun.file(join(import.meta.dir, "..", "client", "icon-512.png")), {
        headers: { "content-type": "image/png" },
      }),
    "/sw.js": () =>
      new Response(Bun.file(join(import.meta.dir, "..", "client", "sw.js")), {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" },
      }),

    // Changes on every restart, so a page left open can notice its own bundle is stale and say so
    // instead of quietly showing yesterday's UI. Tokenless like the shell above: it is one number.
    "/api/build": () => json({ build: BUILD }),

    "/api/projects": async (req) => requireAuth(req) ?? json(await listProjects([ROOT, AGY_ROOT])),

    "/api/records": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;

      const records = await scanRecords(RECORD_ROOTS);
      const links = await readLinks(LINKS_DIR);

      // Hundreds of records share a handful of store directories, and every core directory here is
      // gigabytes of transcript. Listing per record fanned ~1000 concurrent directory scans over the
      // SAME files and took the server past 11 GB in three seconds, so the unit was OOM-killed on the
      // first request a browser made (2026-09-02). One listing per distinct directory, reused.
      const listings = new Map<string, Promise<SessionInfo[]>>();
      const sessionsIn = (dir: string): Promise<SessionInfo[]> => {
        let pending = listings.get(dir);
        if (pending === undefined) {
          pending = listSessions(dir);
          listings.set(dir, pending);
        }
        return pending;
      };

      const resolved = await Promise.all(
        records.map(async (record) => {
          let maxSessionMtime = 0;
          const ownDir = join(ROOT, storeKeyOf(dirname(record.path)));
          const coreDir = join(ROOT, storeKeyOf(cwdFor(record.path)));

          const ownSessions = await sessionsIn(ownDir);
          for (const s of ownSessions) {
            if (s.mtime > maxSessionMtime) maxSessionMtime = s.mtime;
          }

          if (ownDir !== coreDir) {
            const ids = new Set(sessionsOf(record.path, links));
            const coreSessions = await sessionsIn(coreDir);
            for (const s of coreSessions) {
              if (ids.has(s.id) && s.mtime > maxSessionMtime) maxSessionMtime = s.mtime;
            }
          }

          const freshness = Math.max(record.mtime, maxSessionMtime);
          return { ...record, mtime: freshness };
        }),
      );

      return json(recordsWithStaleness(resolved));
    },
    // What loom may read, and where it is running. Both are things only the SERVER knows and the
    // reader needs at the one moment a path is refused: the pane's refusal names the roots it was
    // judged against and offers to hand it to the machine by name (link kind 12, requirement 224).
    "/api/roots": (req) => requireAuth(req) ?? json({ roots: GUARD.roots, host: hostname() }),

    // ── a build's state, derived from the gate's unlock and from git (SPEC 148) ───────
    // The client cannot run git and must not read the unlock itself; it asks, and this answers with
    // the five states, the tree, and what actually changed once a build has landed.
    "/api/plan-state": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const asked = new URL(req.url).searchParams.get("plan");
      if (asked === null) return json({ error: "plan required" }, 400);
      const verdict = await locate(GUARD, asked, new URL(req.url).searchParams.get("base"));
      if (!verdict.ok) return new Response(verdict.reason, { status: verdict.status });
      const repo = verdict.path.includes("/tools/")
        ? verdict.path.slice(0, verdict.path.indexOf("/tools/"))
        : dirname(verdict.path);
      return json(buildState(verdict.path, repo) ?? { error: "unreadable" });
    },

    // ── prototypes: the drawer's third surface (SPEC 134, 136) ───────
    // Scope is the record plus its DESCENDANTS, never a parent — addressed by a scanned record
    // path, the same rule as every record route.
    "/api/prototypes": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const record = await knownRecord(new URL(req.url).searchParams.get("record"));
      if (record === null) return json({ error: "no such project record" }, 404);
      return json(await listPrototypes(await scanRecords(RECORD_ROOTS), record.path, await readLinks(LINKS_DIR), ROOT, AGY_ROOT, GUARD));
    },

    // Where a prototype ENTERED the conversation: the record's store, first mention. The name is
    // matched against the record's own mockups/ listing rather than taken raw, so this cannot be
    // used to probe transcripts for arbitrary strings.
    "/api/prototypes/where": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const url = new URL(req.url);
      const record = await knownRecord(url.searchParams.get("record"));
      if (record === null) return json({ error: "no such project record" }, 404);
      const name = url.searchParams.get("name") ?? "";
      const groups = await listPrototypes(await scanRecords(RECORD_ROOTS), record.path, await readLinks(LINKS_DIR), ROOT, AGY_ROOT, GUARD);
      const owner = groups.find((g) => g.record === record.path && g.files.some((f) => f.name === name));
      if (owner === undefined) return json({ error: "no such prototype" }, 404);
      const key = storeKeyOf(dirname(record.path));
      let found = await findIntroduction(join(ROOT, key), name);
      if (found === null) {
        found = await findIntroduction(join(AGY_ROOT, key), name);
      }
      if (found === null) return json({ error: "no session embeds it" }, 404);
      return json({ key, ...found });
    },

    // The tree's attention marks (SPEC 63, revised by 217). The CLIENT names what it is drawing, so
    // the cost stays bounded by what is on screen instead of walking every project on the machine.
    //
    // `records` is how a project row asks, and it replaced `keys` for that job because a key is an
    // escaped DIRECTORY: since 2026-08-16 a record's sessions do not live in its own directory, so
    // the key matched nothing and every nested record's activity came back empty. That is one bug
    // with two faces — the "new" mark that never cleared, and the unread letter that never lit.
    // `keys` survives for the session POOL, which really is addressed by a store and has no record.
    // GET *and* POST, and the client uses POST — SPEC 233, found while measuring 231.
    //
    // The poll asks about EVERY record in the rail, and there are 185 of them: as a query string
    // that is a 25,804-character URL, and Bun answers it `431 Request Header Fields Too Large` in
    // 1ms. So this route has been failing for every record, silently — `loadActivity` catches and
    // returns, leaving `state.activity` empty. Two things were broken by it and neither looked like
    // this: the rail's unread marks never lit, and `enterRecord`'s fast path, which opens the socket
    // in the click's own tick when activity already names a session, could never fire once. The GET
    // stays for a page still running an older bundle.
    "/api/activity": {
      GET: async (req: Request) => {
        const url = new URL(req.url);
        return activityAnswer(
          req,
          url.searchParams.get("keys") ?? "",
          (url.searchParams.get("records") ?? "").split(",").filter((r) => r.length > 0).map((r) => decodeURIComponent(r)),
        );
      },
      POST: async (req: Request) => {
        let body: { keys?: unknown; records?: unknown } = {};
        try {
          body = (await req.json()) as { keys?: unknown; records?: unknown };
        } catch {
          return json({ error: "bad json" }, 400);
        }
        const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
        const records = Array.isArray(body.records)
          ? body.records.filter((r): r is string => typeof r === "string")
          : [];
        return activityAnswer(req, keys.join(","), records);
      },
    },

    // The account-wide 5-hour meter (SPEC §Bar), now read from the account's own quota endpoint
    // rather than estimated. It is still ONE number for the machine and not a per-project one —
    // a client that could scope the reading would be asking a question the limit does not answer.
    // `session` is the one parameter, and it does not scope anything: it SPLITS the block that was
    // read anyway, so the badge can say how much of the window this session is responsible for.
    // Absent or unknown, the split is simply null and the percentages are unchanged.
    "/api/bar": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const session = new URL(req.url).searchParams.get("session");
      return json(await readBarReading(session));
    },

    // Every budget User spends, not just Anthropic's: two pools on each of two Google accounts
    // and Jules' daily allowance. Each entry says whether its number is current, stale or missing
    // and why, because a budget that cannot be read must look unreadable rather than empty.
    "/api/budgets": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      return json(await readCurrentBudgets(Date.now()));
    },

    // Global read state across devices (SPEC 263, 264).
    "/api/seen": {
      GET: async (req: Request) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return json(await readSeen());
      },
      POST: async (req: Request) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "bad json" }, 400);
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return json({ error: "body must be an object" }, 400);
        }
        await writeSeen(body);
        return json(await readSeen());
      },
    },

    // ── the train: a record's sessions as one line of work (SPEC §Train) ──
    // Addressed by RECORD, because that is what a train belongs to — one record, one train. The
    // store is derived from the record's directory with the same escape `/api/input` spawns under,
    // so the grouping is by construction rather than by a link anyone has to maintain.
    "/api/train": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const record = await knownRecord(new URL(req.url).searchParams.get("record"));
      if (record === null) return json({ error: "no such project record" }, 404);
      const cwd = dirname(record.path);
      const key = storeKeyOf(cwd);
      // A record whose first session is still unsent has no store directory at all — an empty
      // train, not an error: the seam the reader is about to open is its first.
      //
      // Since cores, the record's own store is no longer the whole train: sessions spawned after
      // 2026-08-16 live in the core's store and are found through the link. Both sources, one order.
      const linked = new Set(sessionsOf(record.path, await readLinks(LINKS_DIR)));
      const cars = await assembleTrainFor(
        join(ROOT, key),
        join(ROOT, storeKeyOf(cwdFor(record.path))),
        linked,
        join(AGY_ROOT, key),
        join(AGY_ROOT, storeKeyOf(cwdFor(record.path))),
      );
      return json({ record: record.path, cwd, key: cars.length > 0 ? key : null, cars } satisfies Train);
    },

    // One earlier car, read once. The WebSocket tails the session being TYPED into; a car behind
    // the seam is history and never changes, so it is fetched flat and never watched.
    "/api/transcript": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const url = new URL(req.url);
      const path = sessionTranscriptPath(url.searchParams.get("project") ?? "", url.searchParams.get("session") ?? "");
      if (path === null) return json({ error: "bad params" }, 400);
      if (!(await Bun.file(path).exists())) return json({ error: "no such session" }, 404);
      const tailer = new Tailer(path);
      await tailer.poll();
      const model = tailer.transcript.model();
      return json({ meta: model.meta, messages: model.messages, skipped: model.skipped });
    },

    // ── records: the task surface (SPEC §Tasks) ─────────────────────
    // The record split into prose-before, tasks, prose-after, so the tasks can render as rows with
    // real controls instead of as markdown that only LOOKS like a checklist.
    "/api/record": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const record = await knownRecord(new URL(req.url).searchParams.get("path"));
      if (record === null) return json({ error: "no such project record" }, 404);
      try {
        const doc = parseRecord(await Bun.file(record.path).text());
        return json({ record, ...doc });
      } catch (error) {
        return json({ error: String(error) }, 500);
      }
    },

    "/api/record/task": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as {
          record?: unknown;
          n?: unknown;
          expect?: unknown;
          status?: unknown;
          result?: unknown;
          artifacts?: unknown;
          title?: unknown;
        };
        const record = await knownRecord(body.record);
        if (record === null) return json({ error: "no such project record" }, 404);
        if (typeof body.n !== "number" || !Number.isInteger(body.n)) return json({ error: "n required" }, 400);
        const status = typeof body.status === "string" ? body.status : null;
        if (status !== null && !STATUSES.includes(status as TaskStatus)) {
          return json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
        }

        try {
          let text = await Bun.file(record.path).text();
          const task = parseRecord(text).tasks.find((t) => t.n === body.n);
          if (task === undefined) return json({ error: `no task ${String(body.n)}` }, 404);
          // The record is a live file another session may be editing. The client echoes back the
          // line it drew, so a tick lands on the task the reader saw or on nothing at all.
          if (typeof body.expect === "string" && body.expect !== task.head) {
            return json({ error: "this record changed under you — reload the tab" }, 409);
          }

          const today = new Date().toLocaleDateString("sv");
          // The name first: it rewrites the item's lead, and the two writes below address the same
          // item by its number, which the rename cannot move.
          if (typeof body.title === "string") text = setTitle(text, body.n, body.title);
          if (typeof body.result === "string") {
            const artifacts = Array.isArray(body.artifacts)
              ? body.artifacts.filter((a): a is string => typeof a === "string")
              : [];
            text = setResult(text, body.n, body.result, artifacts, today);
          }
          if (status !== null) text = setStatus(text, body.n, status as TaskStatus);
          await writeAtomic(record.path, text);
          return json({ record, ...parseRecord(text) });
        } catch (error) {
          return json({ error: String(error) }, 400);
        }
      },
    },

    // Adding an item, as opposed to operating one that exists (SPEC 72). There is no line to echo
    // back, so the reader's item COUNT is the echo: a second session adding a task in the meantime
    // is a 409, not a silent double-append.
    "/api/record/add": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as {
          record?: unknown;
          section?: unknown;
          title?: unknown;
          expect?: unknown;
        };
        const record = await knownRecord(body.record);
        if (record === null) return json({ error: "no such project record" }, 404);
        if (body.section !== "next") return json({ error: "section must be next" }, 400);
        if (typeof body.title !== "string" || body.title.trim().length === 0) {
          return json({ error: "a task needs a name" }, 400);
        }

        try {
          const text = await Bun.file(record.path).text();
          if (typeof body.expect === "number" && body.expect !== parseRecord(text).tasks.length) {
            return json({ error: "this record changed under you — reload the tab" }, 409);
          }
          const out = addTask(text, body.title);
          await writeAtomic(record.path, out);
          return json({ record, ...parseRecord(out) });
        } catch (error) {
          return json({ error: String(error) }, 400);
        }
      },
    },

    // Restating a claim's standing (SPEC 73). The six words come from the project linter, so the
    // route validates against that list and loom contributes only the date.
    "/api/record/hypothesis": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as {
          record?: unknown;
          n?: unknown;
          standing?: unknown;
          expect?: unknown;
        };
        const record = await knownRecord(body.record);
        if (record === null) return json({ error: "no such project record" }, 404);
        if (typeof body.n !== "number" || !Number.isInteger(body.n)) return json({ error: "n required" }, 400);
        const standing = typeof body.standing === "string" ? body.standing : "";
        if (!STANDINGS.includes(standing as Standing)) {
          return json({ error: `standing must be one of ${STANDINGS.join(", ")}` }, 400);
        }

        try {
          const text = await Bun.file(record.path).text();
          const claim = parseRecord(text).hypotheses.find((h) => h.n === body.n);
          if (claim === undefined) return json({ error: `no hypothesis ${String(body.n)}` }, 404);
          if (typeof body.expect === "string" && body.expect !== claim.head) {
            return json({ error: "this record changed under you — reload the tab" }, 409);
          }
          // `open` is where a claim starts, not something that happened on a date; the others are
          // findings, and a finding without its date is half a record.
          const date = standing === "open" ? null : new Date().toLocaleDateString("sv");
          const out = setStanding(text, body.n, standing as Standing, date);
          await writeAtomic(record.path, out);
          return json({ record, ...parseRecord(out) });
        } catch (error) {
          return json({ error: String(error) }, 400);
        }
      },
    },

    // The same gate one level up (SPEC 65): a project closes on a VERDICT, never on a finished task
    // list. The gate lives here rather than in the client, so it holds for any caller.
    "/api/record/status": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as {
          record?: unknown;
          status?: unknown;
          verdict?: unknown;
          expect?: unknown;
        };
        const record = await knownRecord(body.record);
        if (record === null) return json({ error: "no such project record" }, 404);

        const status = typeof body.status === "string" ? body.status : "";
        if (!PROJECT_STATUSES.includes(status as ProjectStatus)) {
          return json({ error: `status must be one of ${PROJECT_STATUSES.join(", ")}` }, 400);
        }
        const verdict = typeof body.verdict === "string" ? body.verdict.trim() : "";
        if (status === "done" && verdict.length === 0) {
          return json({ error: "done needs a verdict — which parts landed, and which did not" }, 400);
        }
        // The status the reader saw, echoed back like a task's line: a close cannot land on a record
        // another session moved in the meantime.
        if (typeof body.expect === "string" && body.expect !== record.status) {
          return json({ error: "this record changed under you — reload the tab" }, 409);
        }

        try {
          let text = await Bun.file(record.path).text();
          if (verdict.length > 0) {
            text = setVerdict(text, verdict, new Date().toLocaleDateString("sv"));
          }
          text = setProjectStatus(text, status as ProjectStatus);
          await writeAtomic(record.path, text);
          return json({ path: record.path, status });
        } catch (error) {
          return json({ error: String(error) }, 400);
        }
      },
    },

    // A task that outgrew its line becomes a record of its own — the `project` skill's second move,
    // performed rather than asked for.
    "/api/record/promote": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { record?: unknown; n?: unknown; expect?: unknown };
        const record = await knownRecord(body.record);
        if (record === null) return json({ error: "no such project record" }, 404);
        if (typeof body.n !== "number" || !Number.isInteger(body.n)) return json({ error: "n required" }, 400);
        try {
          const task = parseRecord(await Bun.file(record.path).text()).tasks.find((t) => t.n === body.n);
          if (task === undefined) return json({ error: `no task ${String(body.n)}` }, 404);
          if (typeof body.expect === "string" && body.expect !== task.head) {
            return json({ error: "this record changed under you — reload the tab" }, 409);
          }
          const promotion = await promoteTask(
            record.path,
            record.title,
            body.n,
            new Date().toLocaleDateString("sv"),
          );
          return json(promotion);
        } catch (error) {
          return json({ error: String(error) }, 400);
        }
      },
    },

    // Hand creation (SPEC §Create-and-rename): a title from the panel or a row's context menu
    // becomes a record. `parent` is optional; a parentless record lands in the first record root
    // (the vault's Projects/). The parent, when given, must come from the scan — same rule as
    // every other write route.
    "/api/record/create": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { title?: unknown; parent?: unknown; core?: unknown };
        if (typeof body.title !== "string" || body.title.trim().length === 0) {
          return json({ error: "a project needs a title" }, 400);
        }
        let parentPath: string | null = null;
        if (body.parent !== undefined && body.parent !== null) {
          const parent = await knownRecord(body.parent);
          if (parent === null) return json({ error: "no such parent record" }, 404);
          parentPath = parent.path;
        }
        // A record created while a core is chosen belongs to THAT core. Without this the selector
        // scoped the view and nothing else, so a work project was written to the personal tree and
        // then correctly filtered out of the core it was made in (2026-08-16).
        let chosen = typeof body.core === "string" && body.core.length > 0 ? body.core : null;
        if (chosen === "lena") chosen = "spouse"; // leak-ok: legacy id accepted at the read boundary
        const root = chosen === null ? RECORD_ROOTS[0] : homeFor(chosen);
        if (root === undefined) return json({ error: "no record root configured" }, 500);
        // A home outside every record root would create something the scan never returns again.
        if (!RECORD_ROOTS.some((r) => resolvePath(root) === resolvePath(r) || resolvePath(root).startsWith(`${resolvePath(r)}/`))) {
          return json({ error: "that core has no home inside the record roots" }, 400);
        }
        try {
          const creation = await createRecord(
            body.title,
            parentPath,
            root,
            new Date().toLocaleDateString("sv"),
          );
          return json(creation);
        } catch (error) {
          return json({ error: String(error) }, 400);
        }
      },
    },

    "/api/record/reference": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { record?: unknown; target?: unknown; why?: unknown; expect?: unknown };
        const record = await knownRecord(body.record);
        if (record === null) return json({ error: "no such project record" }, 404);
        if (typeof body.target !== "string" || body.target.trim().length === 0) {
          return json({ error: "a reference needs a target path" }, 400);
        }
        if (typeof body.expect !== "string") return json({ error: "expect required" }, 400);
        const why = typeof body.why === "string" ? body.why.trim() : "";
        try {
          await addReference(record.path, body.target, why, body.expect);
          return json({ ok: true });
        } catch (error) {
          const message = String(error);
          return json({ error: message }, /changed under you/.test(message) ? 409 : 400);
        }
      },
    },

    // Rename (SPEC §Create-and-rename): rewrites the `#` line and ripples into the parent's
    // referencing line. `expect` carries the title the client saw — a mismatch is a 409, the same
    // optimistic-concurrency story as the task routes.
    "/api/record/rename": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { record?: unknown; title?: unknown; expect?: unknown };
        const record = await knownRecord(body.record);
        if (record === null) return json({ error: "no such project record" }, 404);
        if (typeof body.title !== "string" || body.title.trim().length === 0) {
          return json({ error: "a project needs a title" }, 400);
        }
        if (typeof body.expect !== "string") return json({ error: "expect required" }, 400);
        try {
          await renameRecord(record.path, body.title, body.expect);
          return json({ ok: true });
        } catch (error) {
          const message = String(error);
          return json({ error: message }, /changed under you/.test(message) ? 409 : 400);
        }
      },
    },

    "/api/projects/:key/sessions": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const key = req.params.key;
      if (!SAFE.test(key)) return json({ error: "bad project key" }, 400);
      const sessions = await listSessionsForProject(key, ROOT, AGY_ROOT);
      return json(attachPicks(sessions, await readAllPicks(STATE_DIR)));
    },

    // A record's sessions, now that a shared cwd no longer groups them by construction. Linked
    // sessions come first; then the store the record's OWN directory names, which is what keeps
    // every session written before 2026-08-16 — and every terminal session — visible. The fallback
    // is not a migration step, it is the permanent answer for sessions loom did not spawn.
    // The cores themselves, so the panel's selector is not a second copy of the list. `usable` is
    // the honest half: Spouse is declared and has no vault, and a selector that hid her would say
    // nothing, while one that offered her would spawn a session into a directory with no rules.
    "/api/cores": async (req: Request) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const usable = new Set(usableCores().map((c) => c.id));
      return json(CORES.map((c) => ({ id: c.id, label: c.label, usable: usable.has(c.id) })));
    },

    "/api/records/sessions": {
      GET: async (req: Request) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const asked = new URL(req.url).searchParams.get("record");
        if (asked === null) return json({ error: "record required" }, 400);
        // `knownRecord`, not a second copy of it: the self-healing miss (SPEC 231) must live in
        // one place, and this route is the one the rail waits on when a project is clicked.
        const record = await knownRecord(asked);
        if (record === null) return json({ error: "no such project record" }, 404);
        const ownKey = storeKeyOf(dirname(record.path));
        const coreKey = storeKeyOf(cwdFor(record.path));
        // A record whose core IS its own directory — every test fixture, and everything outside the
        // vault — has one store, so there is nothing to merge. Short-circuit rather than list the
        // same directory twice and reconcile it with itself: that doubled work sat on the path the
        // client polls during adoption, and `journey2-input` tipped over under gate load while
        // passing solo. A pin must not own a clock, and this pin does — so take the cost away.
        if (ownKey === coreKey) {
          const sessions = await listSessionsForProject(ownKey, ROOT, AGY_ROOT);
          return json(attachPicks(sessions, await readAllPicks(STATE_DIR)));
        }
        // One merge, in `links.ts`, shared with `/api/activity` and pinned there — see `mergeByLink`
        // for why the re-sort is the contract rather than a nicety.
        const ids = new Set(sessionsOf(record.path, await readLinks(LINKS_DIR)));
        const ownSessions = await listSessionsForProject(ownKey, ROOT, AGY_ROOT);
        const coreSessions = await listSessionsForProject(coreKey, ROOT, AGY_ROOT);
        const merged = mergeByLink(ownSessions, coreSessions, ids);
        return json(attachPicks(merged, await readAllPicks(STATE_DIR)));
      },
    },

    "/api/projects/:key/sessions/:id/pins": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const { key, id } = req.params;
      if (!SAFE.test(key) || !SAFE.test(id)) return json({ error: "bad id" }, 400);
      return json(await readPins(STATE_DIR, id));
    },

    "/api/pin": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as {
          session?: unknown;
          uuid?: unknown;
          pinned?: unknown;
          note?: unknown;
        };
        if (typeof body.session !== "string" || typeof body.uuid !== "string") {
          return json({ error: "session and uuid required" }, 400);
        }
        const note = typeof body.note === "string" ? body.note : null;
        try {
          const pins = await setPin(
            STATE_DIR,
            body.session,
            body.uuid,
            body.pinned !== false,
            note,
            new Date().toISOString(),
          );
          return json(pins);
        } catch (error) {
          return json({ error: String(error) }, 400);
        }
      },
    },

    // The one route that takes a filesystem path. Images stream as bytes (a `grid` block's <img>
    // points here); everything readable comes back as JSON for the file pane. Every path goes
    // through the guard first — see server/files.ts for why an unbounded reader is not acceptable
    // on this port.
    "/api/file": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const params = new URL(req.url).searchParams;
      // `wiki=` is a note NAME, not a path: `[[A note]]` says which note without saying where it is,
      // so the vault index answers that before the guard sees anything (link kind 11). The answer is
      // then judged like any other path — the index only ever proposes.
      const wiki = params.get("wiki");
      let raw = params.get("path");
      if (wiki !== null && wiki.length > 0) {
        const found = await resolveWiki(wikiScope(GUARD, VAULT_ROOT), wiki);
        if (found === null) return new Response(`no note named "${wiki}" in the vault`, { status: 404 });
        raw = found;
      }
      if (raw === null) return new Response("path required", { status: 400 });
      // `base` is the session's cwd, sent by the client so a RELATIVE chip resolves against the tree
      // the prose was written about and not only the record directory (SPEC 143).
      // `record` is the record the reader has open: a second ladder, tried only when the session's
      // own missed (SPEC 245).
      const verdict = await locate(GUARD, raw, params.get("base"), params.get("record"));
      if (!verdict.ok) return new Response(verdict.reason, { status: verdict.status });

      // A directory answers with a LISTING rather than the 404 it used to give: a chip to a folder
      // is a normal thing to write, and the pane draws each entry as a chip of its own (SPEC 141).
      let entry: Stats;
      try {
        entry = await stat(verdict.path);
      } catch {
        return new Response("not found", { status: 404 });
      }
      if (entry.isDirectory()) {
        return json({ path: verdict.path, kind: "dir", bytes: 0, text: "", entries: await listDir(verdict.path) });
      }

      let kind = kindOf(verdict.path);

      const file = Bun.file(verdict.path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });

      // `raw=1` serves the document itself — how a prototype opens in its own browser tab. The CSP
      // sandbox keeps it opaque-origin there, the same stance the iframe block takes: it may run,
      // it may not reach the loom API or storage the cookie would otherwise hand it.
      if (new URL(req.url).searchParams.get("raw") === "1") {
        const html = /\.html?$/i.test(verdict.path);
        const svg = /\.svg$/i.test(verdict.path);
        const pdf = /\.pdf$/i.test(verdict.path);

        let contentType = "text/plain; charset=utf-8";
        if (html) contentType = "text/html; charset=utf-8";
        else if (svg) contentType = "image/svg+xml; charset=utf-8";
        else if (pdf) contentType = "application/pdf";
        else if (kind === "image") {
          // If it's another image kind, we shouldn't force text/plain.
          // We can use Bun's default by not overriding it or we can just send the file response directly.
          // Let's use file.type for standard images since Bun resolves it.
          contentType = file.type;
        }

        return new Response(file, {
          headers: {
            "content-type": contentType,
            "content-security-policy": "sandbox allow-scripts",
          },
        });
      }

      if (kind === "image") return new Response(file);

      // JSON path reads max 10MB into memory. But it ALWAYS returns something.
      // If > 10MB it still truncates to 2MB, same as between 2MB and 10MB.
      // So actually, if >10MB we don't reject. We just read 2MB anyway.

      const truncated = file.size > MAX_BYTES;
      const sliceSize = truncated ? MAX_BYTES + 4 : file.size;
      const rawBytes = new Uint8Array(await file.slice(0, sliceSize).arrayBuffer());
      const bytes = truncated ? truncateUtf8(rawBytes, MAX_BYTES) : rawBytes;

      if (looksBinary(bytes)) {
        kind = "download";
      }

      return json({
        path: verdict.path,
        kind,
        bytes: file.size,
        text: kind === "download" ? "" : new TextDecoder().decode(bytes),
        truncated: truncated && kind !== "download" ? true : undefined
      });
    },

    "/api/models": {
      GET: (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return json({ models: MODEL_SPECS });
      },
    },

    // ── the write path (SPEC §Input path) ───────────────────────────

    "/api/input": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as {
          project?: unknown;
          record?: unknown;
          session?: unknown;
          text?: unknown;
          mode?: unknown;
          model?: unknown;
          effort?: unknown;
          browser?: unknown;
          images?: unknown;
        };
        if (typeof body.text !== "string") return json({ error: "text required" }, 400);
        const resume = typeof body.session === "string";
        if (resume && !SAFE.test(body.session as string)) return json({ error: "bad session id" }, 400);

        // Two ways to name where the child runs: an existing transcript-store project, or a
        // project RECORD — whose directory becomes the cwd, so a record's sessions group in the
        // store by construction (workspace bet). The record must come from the scan, never as a
        // raw path: this route must not become "spawn a process in any directory you name".
        let cwd: string | null = null;
        let linkRecord: string | null = null;
        let linkTitle: string | null = null;
        if (typeof body.record === "string") {
          const record = await knownRecord(body.record);
          if (record === null) return json({ error: "no such project record" }, 404);
          // The record picks the CORE the child runs in, not a directory of its own. The CLI reads
          // skills, output style and CLAUDE.md from the cwd and does not walk up, so a session in a
          // project folder had none of them — this conversation started in `tablet-for-drawing`
          // with 3 skills instead of 31 and no Plain style (2026-08-16). Which project the session
          // BELONGS to is the stored link below; it is no longer the cwd's job to say.
          cwd = cwdFor(record.path);
          linkRecord = record.path;
          linkTitle = record.title;
        } else if (typeof body.project === "string" && SAFE.test(body.project)) {
          const project = (await listProjects(ROOT)).find((p) => p.key === body.project);
          if (project === undefined) return json({ error: "no such project" }, 404);
          cwd = project.cwd;
        } else {
          return json({ error: "project key or record path required" }, 400);
        }
        if (cwd === null) return json({ error: "project has no readable cwd" }, 400);

        // Pasted images: validated shape, image/* only, 10MB total — the transcript stores these
        // verbatim, and an unbounded accept would let one paste balloon a session file.
        const images: { mediaType: string; data: string }[] = [];
        if (Array.isArray(body.images)) {
          let total = 0;
          for (const raw of body.images) {
            const img = raw as { mediaType?: unknown; data?: unknown };
            if (typeof img.mediaType !== "string" || !img.mediaType.startsWith("image/")) {
              return json({ error: "images must be image/* attachments" }, 400);
            }
            if (typeof img.data !== "string") return json({ error: "image data must be base64" }, 400);
            total += img.data.length;
            if (total > 10 * 1024 * 1024) return json({ error: "attachments exceed 10MB" }, 413);
            images.push({ mediaType: img.mediaType, data: img.data });
          }
        }

        const sessionId = resume ? (body.session as string) : crypto.randomUUID();
        // Written BEFORE the send, so a child that dies on its first turn still belongs somewhere.
        //
        // A link never changes, so re-writing it on every send put a read-modify-write of links.json
        // on the hot path: three rapid sends then raced their own queue and `journey2-input` lost the
        // pending ghost, because the third message reached the runner after the first two had already
        // finished. So the write stays off the hot path — but "resumed means already linked" was only
        // ever true of sessions created after links existed. A session created before that, or by the
        // `body.project` route which sets no record at all, was resumed under a record forever and
        // never linked to it, and the derived fallback that used to cover it stopped naming a project
        // when cores landed. It then belonged nowhere, which he read as it detaching by itself.
        //
        // ADOPTION, once per session per process: `adopted` keeps the read off every subsequent send,
        // so a resumed session costs one links.json read the first time it is sent to and nothing
        // after that.
        if (linkRecord !== null && !resume) {
          await writeLink(LINKS_DIR, sessionId, linkRecord);
          adopted.add(sessionId);
        } else if (linkRecord !== null && resume && !adopted.has(sessionId)) {
          adopted.add(sessionId);
          if (!(await readLinks(LINKS_DIR)).has(sessionId)) {
            await writeLink(LINKS_DIR, sessionId, linkRecord);
          }
        }
        // Requirement 174: claim whatever the seam started, BEFORE the send. Landed already means it
        // rides THIS message — the first one — which is the entire point of starting it at the
        // button. Order is the whole requirement here: `runner.send` consumes the prelude, so a
        // carry that happens after it is a carry for the NEXT message, which is precisely the
        // "it attached to my second message" defect this is fixing (2026-08-13). Still running means
        // this session is registered as the claimant, so it is delivered the moment it lands and no
        // second recap is ever started beside it.
        // Keyed on the RECORD's directory, never on `cwd` (SPEC 217). They were the same path until
        // 2026-08-16; since cores, `cwd` is the directory every project under the core shares, so
        // claiming against it hands one project's recap to whichever project sent next.
        const recapDir = linkRecord !== null ? dirname(linkRecord) : cwd;
        const claimed = resume ? { state: "absent" as const } : claimWarm(recapDir, (entry, reason) => {
          if (entry !== null) runner.carry(sessionId, reminderFor(entry));
          deliverRecap(sessionId, entry, reason);
        });
        if (claimed.state === "landed" && claimed.entry !== null) {
          runner.carry(sessionId, reminderFor(claimed.entry));
        }
        // Auto unless cards is asked for by name — SPEC 42.
        const mode = body.mode === "cards" ? "cards" : "auto";
        // Model and thinking level: allowlisted, anything else falls back to the CLI default
        // rather than 400-ing — a stale picker value must not block a send (SPEC 49).
        // Never refused for being busy: the session's live child queues stdin messages and answers
        // them in order, which is what makes typing a follow-up mid-turn possible (SPEC 106).
        const started = runner.send({
          sessionId,
          resume,
          cwd,
          text: body.text,
          mode,
          model: asModel(body.model),
          effort: asEffort(body.effort),
          // MCP off unless this turn asked for a browser: the servers' connect/disconnect churn
          // invalidates the prompt prefix and re-sends the whole conversation as a write
          // (input.ts, childArgs). Absent or junk means off — the expensive side is never default.
          browser: body.browser === true,
          // The cwd used to say which project this was; since cores it says which vault. So the
          // child is told, in its system prompt rather than in his message.
          ...(linkRecord !== null
            ? {
                project: {
                  title: linkTitle ?? "(untitled)",
                  record: linkRecord,
                  frame: await frameOf(linkRecord),
                  references: await (async () => {
                    const r = await knownRecord(linkRecord);
                    if (r === null || r.references.length === 0) return undefined;
                    const resolved = [];
                    for (const ref of r.references) {
                      const refPath = resolvePath(dirname(linkRecord), ref.path);
                      const refRecord = await knownRecord(refPath);
                      if (refRecord !== null) {
                        resolved.push({ title: refRecord.title, path: ref.path, why: ref.why });
                      }
                    }
                    return resolved;
                  })(),
                },
              }
            : {}),
          images,
        });
        if (!started.ok) return json({ error: started.reason }, started.status);
        // The accept time, written down before it can be forgotten (SPEC 145). The queue holds it
        // only until the message is answered, and the CLI stamps the transcript row with PICKUP
        // time — so without this the message jumps from where it was sent to the end of whatever
        // the running turn produced meanwhile. The just-accepted message is the queue's last entry.
        const accepted = started.pending.at(-1);
        if (accepted !== undefined) {
          await addAccept(STATE_DIR, sessionId, accepted);
          await writePick(STATE_DIR, sessionId, {
            model: asModelId(body.model),
            effort: asEffort(body.effort),
            mode: mode,
          });
        }
        // The queue comes back with the answer: a send that CREATES a session has no socket attached
        // to it yet, so the response is the only place its first echo can come from (SPEC 138).
        // The block itself goes out after the send, not before it: nothing on screen may depend on
        // the recap, and the response is the first echo's only route (SPEC 138).
        if (claimed.state === "landed") {
          const { entry, reason } = claimed;
          queueMicrotask(() => deliverRecap(sessionId, entry, reason));
        }

        // The fallback, for a session created without a seam being cut first — the phone, a fresh
        // window, a resumed train. A send that CREATES a session is the first moment the previous
        // car is unambiguously previous, and the send has already gone, so nothing below can delay
        // him. Deliberately not awaited.
        if (!resume && claimed.state === "absent") {
          void recapForNewSession(
            {
              bin: CLAUDE_BIN,
              transcriptRoot: ROOT,
              stateDir: STATE_DIR,
              scratchDir: RECAP_SCRATCH,
              store: await storeFor(linkRecord, cwd),
              now: () => new Date().toISOString(),
              appendEntry,
              report: (phase: RecapPhase) => {
                // Ready means two things: put it on his screen, and hand it to the next send. It is
                // NOT sent now — the send that carries it is one of his, so the recap never becomes
                // a turn of its own (requirement 175).
                if (phase.phase === "ready") {
                  runner.carry(sessionId, reminderFor(phase.entry));
                }
                const frame: Frame = {
                  type: "recap",
                  phase: phase.phase,
                  entry: phase.phase === "ready" ? phase.entry : null,
                  reason: phase.phase === "failed" ? phase.reason : null,
                  startedAt: phase.phase === "running" ? new Date().toISOString() : null,
                };
                if (phase.phase === "none") lastRecap.delete(sessionId);
                else lastRecap.set(sessionId, frame);
                broadcastToSession(sessionId, frame);
              },
            },
            recapDir,
            sessionId,
          );
        }
        return json({ session: sessionId, resumed: resume, queued: started.queued, pending: started.pending });
      },
    },

    // Drafts: one file per key, last-writer-wins by `at`. A `new:` key is stored on disk but not
    // broadcast over WebSocket because no session exists to broadcast to yet.
    "/api/draft": {
      GET: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const key = new URL(req.url).searchParams.get("key");
        if (typeof key !== "string") return json({ error: "key required" }, 400);
        return json(await readDraft(STATE_DIR, key));
      },
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        let body: unknown;
        try {
          // sendBeacon posts application/json bodies but we might need req.json() or read it from text.
          // req.json() automatically works for application/json bodies, even from blobs.
          body = await req.json();
        } catch {
          return json({ error: "invalid json" }, 400);
        }

        if (typeof body !== "object" || body === null) return json({ error: "bad payload" }, 400);
        const b = body as Record<string, unknown>;
        if (typeof b.key !== "string") return json({ error: "bad key" }, 400);
        if (typeof b.text !== "string") return json({ error: "bad text" }, 400);
        if (b.text.length > 200000) return json({ error: "text too long" }, 400);
        if (typeof b.at !== "number" || !Number.isFinite(b.at)) return json({ error: "bad at" }, 400);

        const stored = await writeDraft(STATE_DIR, b.key, { text: b.text, at: b.at });

        if (!b.key.startsWith("new:") && stored.text === b.text && stored.at === b.at) {
          // value was changed. broadcast.
          broadcastToSession(b.key, { type: "draft", key: b.key, text: stored.text, at: stored.at });
        }

        return json(stored);
      },
    },

    // The block after a reload: the ledger is the truth, not the socket frame that delivered it.
    //
    // With a `session`, this is the block itself (requirement 180) — the newest entry about the car
    // BEFORE it, and nothing at all for an old car, a refused one, or a record whose ledger says
    // nothing about its predecessor. It restores the screen and never the carry: the reminder either
    // already rode his first message or never will, so this cannot become a second delivery.
    "/api/recap": {
      GET: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const url = new URL(req.url);
        const target = await recapTargetOf(url.searchParams.get("record"));
        if (target === null) return json({ error: "no such project record" }, 404);
        const session = url.searchParams.get("session");
        if (session === null) return json({ entries: await readLedger(target.dir) });
        if (!SAFE.test(session)) return json({ error: "bad session" }, 400);
        const entry = await restorableFor(target.store, STATE_DIR, target.dir, session);
        return json(entry === null ? { phase: "none" } : { phase: "ready", entry, from: "ledger" });
      },
    },

    // Requirement 174: the recap starts when the SEAM is cut, so it is ready for his FIRST message.
    // No session exists at this point, so the result waits against the record — and the block has no
    // socket to be pushed down either, which is what the GET is for: until a session exists, the
    // screen asks. Without it the block spins forever for anyone who cuts a seam and does not type.
    "/api/recap/warm": {
      GET: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const target = await recapTargetOf(new URL(req.url).searchParams.get("record"));
        if (target === null) return json({ error: "no such project record" }, 404);
        const held = peekWarm(target.dir);
        if (held === null) return json({ phase: "absent" });
        // `at` is the clock's zero (requirement 181): a screen that started watching late — a reload,
        // a second tab — must count from when the recap started, not from when it noticed.
        if (held.running) return json({ phase: "running", at: held.at });
        return json(held.entry !== null
          ? { phase: "ready", entry: held.entry }
          : { phase: held.reason !== null ? "failed" : "none", reason: held.reason });
      },
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { record?: unknown };
        const target = await recapTargetOf(body.record);
        if (target === null) return json({ error: "no such project record" }, 404);
        const dir = target.dir;
        if (warmRunning(dir)) return json({ ok: true, already: true });
        const gen = warmStart(dir, new Date().toISOString());
        void recapForNewSession(
          {
            bin: CLAUDE_BIN,
            transcriptRoot: ROOT,
            stateDir: STATE_DIR,
            scratchDir: RECAP_SCRATCH,
            store: target.store,
            now: () => new Date().toISOString(),
            appendEntry,
            report: (phase: RecapPhase) => {
              if (phase.phase === "ready") warmFinish(dir, gen, phase.entry, null);
              else if (phase.phase === "failed") warmFinish(dir, gen, null, phase.reason);
              else if (phase.phase === "none") warmFinish(dir, gen, null, null);
            },
          },
          dir,
          // No session id yet — nothing to exclude, the newest car IS the one being left.
          "",
        );
        return json({ ok: true });
      },
    },

    // Scenario 7: run it again. Appends a new entry naming the one it supersedes — the file is
    // never edited, so "show the newest" and "append only" stay compatible.
    "/api/recap/rerun": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { session?: unknown; record?: unknown };
        const target = await recapTargetOf(body.record);
        if (typeof body.session !== "string" || target === null) {
          return json({ error: "session and record required" }, 400);
        }
        const forSession = body.session;
        void recapForNewSession(
          {
            bin: CLAUDE_BIN,
            transcriptRoot: ROOT,
            stateDir: STATE_DIR,
            scratchDir: RECAP_SCRATCH,
            store: target.store,
            now: () => new Date().toISOString(),
            appendEntry,
            report: (phase: RecapPhase) => {
              if (phase.phase === "ready") runner.carry(forSession, reminderFor(phase.entry));
              const frame: Frame = {
                type: "recap",
                phase: phase.phase,
                entry: phase.phase === "ready" ? phase.entry : null,
                reason: phase.phase === "failed" ? phase.reason : null,
                startedAt: phase.phase === "running" ? new Date().toISOString() : null,
              };
              if (phase.phase === "none") lastRecap.delete(forSession);
              else lastRecap.set(forSession, frame);
              broadcastToSession(forSession, frame);
            },
          },
          target.dir,
          forSession,
        );
        return json({ ok: true });
      },
    },

    // Requirement 176: refusable. The entry stays in the ledger; only the injection dies.
    "/api/recap/dismiss": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { session?: unknown; record?: unknown };
        const target = await recapTargetOf(body.record);
        // Scenario 2's first half: refused BEFORE the first send, when there is no session to record
        // it against. The warm recap is dropped instead, so no reminder is ever carried and the
        // ledger keeps whatever it already has.
        if (typeof body.session !== "string" && target !== null) {
          dropWarm(target.dir);
          return json({ ok: true, dropped: true });
        }
        if (typeof body.session !== "string" || !SAFE.test(body.session)) {
          return json({ error: "session or record required" }, 400);
        }
        if (target !== null) dropWarm(target.dir);
        await dismiss(STATE_DIR, body.session, new Date().toISOString());
        return json({ ok: true });
      },
    },

    // Stop the turn in flight without losing the session or anything queued behind it (SPEC 106).
    "/api/interrupt": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { session?: unknown };
        if (typeof body.session !== "string" || !SAFE.test(body.session)) {
          return json({ error: "session required" }, 400);
        }
        const stopped = await runner.interrupt(body.session);
        return stopped ? json({ ok: true }) : json({ error: "nothing running in that session" }, 404);
      },
    },

    // The blocked hook's long-poll. The response IS the verdict, so this handler intentionally
    // awaits for up to the broker timeout.
    "/api/permit/ask": {
      POST: async (req) => {
        if (!isLoopback(req)) return json({ error: "hooks are local" }, 403);
        const body = (await req.json()) as { sessionId?: unknown; toolName?: unknown; toolInput?: unknown };
        if (typeof body.sessionId !== "string" || typeof body.toolName !== "string") {
          return json({ error: "sessionId and toolName required" }, 400);
        }
        const verdict = await broker.ask(body.sessionId, body.toolName, body.toolInput ?? null);
        return json({ verdict, reason: `loom: ${verdict === "allow" ? "allowed" : "denied"} by User` });
      },
    },

    "/api/permit/answer": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { id?: unknown; verdict?: unknown };
        if (typeof body.id !== "string" || (body.verdict !== "allow" && body.verdict !== "deny")) {
          return json({ error: "id and verdict allow|deny required" }, 400);
        }
        const settled = broker.answer(body.id, body.verdict as Verdict);
        return settled ? json({ ok: true }) : json({ error: "no such pending permit" }, 404);
      },
    },

    // Test-only: sever every websocket without closing it politely, the way sleep or a dropped
    // network does. 404 outside NODE_ENV=test so it is not a surface in production.
    "/api/test/drop-sockets": {
      POST: (req) => {
        if (Bun.env["NODE_ENV"] !== "test") return json({ error: "not found" }, 404);
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        let dropped = 0;
        for (const socket of liveSockets) {
          socket.terminate();
          dropped += 1;
        }
        return json({ dropped });
      },
    },

    "/api/jules": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (id !== null) {
        const task = await readTask(STATE_DIR, id);
        if (task === null) return json({ error: "no such task" }, 404);
        return json(task);
      }
      return json(await listTasks(STATE_DIR));
    },

    "/api/jules/task": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const client = julesClientOrNull(join(import.meta.dir, "..", "..", "jules"));
      if (client === null) return json({ error: "no jules api key" }, 503);
      
      const body = (await req.json()) as {
        session: string;
        prompt: string;
        title: string;
        source: string | null;
        branch: string | null;
      };
      
      const task = await createTask(
        STATE_DIR,
        { loomSession: body.session, prompt: body.prompt, title: body.title, source: body.source, branch: body.branch },
        () => client.createSession({ prompt: body.prompt, title: body.title, source: body.source ?? undefined, branch: body.branch ?? undefined })
      );

      startPolling(
        STATE_DIR,
        task.id,
        (t) => broadcastToSession(t.loomSession, { type: "jules", task: t }),
        (id) => client.getSession(id)
      );
      
      return json(task);
    },

    // Test-only: force one session's child to retire (`Runner.testRetire`) without contriving a
    // model change, a dead pipe, eviction or `shutdown()` through the UI — the driven suite's way
    // to reproduce "a retire happened while the socket was severed" (session-truth step 6).
    "/api/test/retire": {
      POST: (req) => {
        if (Bun.env["NODE_ENV"] !== "test") return json({ error: "not found" }, 404);
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const id = new URL(req.url).searchParams.get("session") ?? "";
        if (id.length === 0) return json({ error: "session required" }, 400);
        runner.testRetire(id, "test forced retire");
        return json({ ok: true });
      },
    },

    // The Runner's live truth for one session, independent of any socket (session-truth step 6).
    // A reconnecting client asks this ONCE to correct `state.job` when the terminal event `retire()`
    // now emits (step 5) fired while the socket was down and so was never delivered — the same shape
    // the WS `job` frame already carries, so the client can feed either into the same `setJob()`.
    "/api/session-state": {
      GET: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const id = new URL(req.url).searchParams.get("session") ?? "";
        if (id.length === 0) return json({ error: "session required" }, 400);

        let act: SessionActivity | null = null;
        for (const [key] of watchers) {
          if (key.endsWith(`/${id}`)) {
            const [projKey] = key.split("/");
            if (projKey !== undefined) {
              act = (await activityOf(join(AGY_ROOT, projKey), `${id}.jsonl`)) ?? (await activityOf(join(ROOT, projKey), `${id}.jsonl`));
            }
            if (act !== null) break;
          }
        }
        if (act === null) {
          const links = await readLinks(LINKS_DIR);
          const recordPath = links.get(id);
          if (recordPath !== undefined) {
            const coreKey = storeKeyOf(cwdFor(recordPath));
            act = (await activityOf(join(AGY_ROOT, coreKey), `${id}.jsonl`)) ?? (await activityOf(join(ROOT, coreKey), `${id}.jsonl`));
            if (act === null) {
              const ownKey = storeKeyOf(dirname(recordPath));
              if (ownKey !== coreKey) {
                act = (await activityOf(join(AGY_ROOT, ownKey), `${id}.jsonl`)) ?? (await activityOf(join(ROOT, ownKey), `${id}.jsonl`));
              }
            }
          }
        }
        // If no bounded lookup located the session's store (an unlinked session with no active watcher),
        // skip the staleness check and answer from the runner alone rather than sweeping every project directory
        // on a latency-critical path. A missed staleness check on this endpoint is far cheaper than a sweep.
        if (act !== null) {
          const newest = Math.max(act.lastReply, act.lastTyped);
          const transcriptSaysEnded = newest > 0 && act.lastEnded >= newest;
          runner.stale(id, transcriptSaysEnded);
        }

        return json({
          state: runner.running(id) ? "running" : "idle",
          queued: runner.queued(id),
          pending: runner.pending(id),
          ...runner.step(id),
        });
      },
    },

    "/api/open": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const body = (await req.json()) as { path?: unknown };
        if (typeof body.path !== "string" || body.path.length === 0) {
          return json({ error: "path required" }, 400);
        }
        return json(await openPath(body.path));
      },
    },
  },

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    if (!authed(req, TOKEN, PORT)) return new Response("unauthenticated", { status: 401 });

    const key = url.searchParams.get("project") ?? "";
    const id = url.searchParams.get("session") ?? "";
    const path = sessionTranscriptPath(key, id);
    if (path === null) return new Response("bad params", { status: 400 });
    if (!(await Bun.file(path).exists())) return new Response("no such session", { status: 404 });

    const watchKey = `${key}/${id}`;
    if (server.upgrade(req, { data: { watchKey } })) return undefined;
    return new Response("upgrade failed", { status: 400 });
  },

  websocket: {
    async open(socket) {
      liveSockets.add(socket);
      const [key = "", id = ""] = socket.data.watchKey.split("/");
      const path = sessionTranscriptPath(key, id);
      if (path === null) {
        socket.send(JSON.stringify({ type: "error", message: "bad session" } satisfies Frame));
        socket.close();
        return;
      }
      let watcher = watchers.get(socket.data.watchKey);
      if (watcher === undefined) {
        watcher = new Watcher(socket.data.watchKey, path, (gone) => {
          // Only if the map still points at the watcher that emptied. A watcher that emptied late
          // would otherwise evict its own replacement, and the replacement's sockets would be the
          // ones cut off from every job and permit frame — the same failure one step removed.
          if (watchers.get(socket.data.watchKey) === gone) watchers.delete(socket.data.watchKey);
        });
        watchers.set(socket.data.watchKey, watcher);
      }
      // Before the first await, and this ordering is the fix: see `Watcher.hold`.
      watcher.hold(socket);
      await watcher.attach(socket, await readPins(STATE_DIR, id), await readAccepts(STATE_DIR, id));
      // A late-joining device must see what is already pending (SPEC 35).
      socket.send(JSON.stringify({ type: "permits", permits: broker.forSession(id) } satisfies Frame));
      // Including the step, and how long it has already been shown: a phone that reloads mid-turn
      // must land on the live indication, not on a blank one waiting for the next frame (SPEC 96).
      // And including the QUEUE ITSELF, not just its length — otherwise a reload mid-queue draws
      // the spinner over a transcript with no sign of the message being waited on (SPEC 138).
      //
      // Sent whether or not a turn is running, because this frame is what RECONCILES the client's
      // echoes: a device that attaches to an idle session must be told the queue is empty, or an
      // echo whose reply landed while that device was away has nothing to clear it. `detail` is null
      // here, which is what keeps the idle frame from toasting as a finished turn.
      socket.send(
        JSON.stringify({
          type: "job",
          state: runner.running(id) ? "running" : "done",
          detail: null,
          queued: runner.queued(id),
          pending: runner.pending(id),
          ...runner.step(id),
        } satisfies Frame),
      );
      // The block, if this session is carrying one and he has not refused it. Sent on attach for the
      // same reason the job frame is: the socket that needed it did not exist when it was ready.
      const carried = lastRecap.get(id);
      if (carried !== undefined) {
        void readDismissals(STATE_DIR).then((refused) => {
          if (refused[id] === undefined) socket.send(JSON.stringify(carried));
        });
      }
      // Staleness check is deferred until after the initial job/permit frames are sent so the
      // WebSocket attach path is not delayed by filesystem reads. If the runner is stale,
      // runner.stale() emits a job event that will broadcast and correct the client.
      const act = (await activityOf(join(AGY_ROOT, key), `${id}.jsonl`)) ?? (await activityOf(join(ROOT, key), `${id}.jsonl`));
      if (act !== null) {
        const newest = Math.max(act.lastReply, act.lastTyped);
        const transcriptSaysEnded = newest > 0 && act.lastEnded >= newest;
        runner.stale(id, transcriptSaysEnded);
      }
    },
    close(socket) {
      liveSockets.delete(socket);
      watchers.get(socket.data.watchKey)?.detach(socket);
    },
    message() {
      // Phase one is read-only: the client has nothing to say. See SPEC "Out of scope".
    },
  },
});

console.log(`loom → ${server.url}`);
console.log(`  transcripts:     ${ROOT}`);
console.log(`  agy transcripts: ${AGY_ROOT}`);
console.log(`  state:           ${STATE_DIR}`);
console.log(`  readable:        ${GUARD.roots.join(" · ")}`);
// Printed only when set, and printed at all because a MISPARSED alias is otherwise invisible:
// `parseAliases` drops a pair it cannot mean rather than guessing, so the difference between
// "configured" and "silently dropped" has to be readable off the boot line.
if (GUARD.aliases.length > 0) {
  console.log(`  aliases:     ${GUARD.aliases.map(([f, t]) => `${f} → ${t}`).join(" · ")}`);
}
console.log(`  onboard a device: http://<this-host>:${PORT}/login?token=${TOKEN}`);

/**
 * LEAVE the children running on the way out, and write down where each one got to (SPEC 255).
 *
 * This handler used to be defence in depth against orphans, on a claim that was false in the other
 * direction: the note here recorded, correctly, that a dying loom closes every child's stdin and the
 * CLI exits on the EOF — and that was the bug, not the safety net. It ended one of User's live
 * sessions on 2026-08-15 and twice on 2026-08-05. `KillMode=process` (`home.nix`) spares the child
 * the restart's SIGTERM; it could do nothing about the pipes.
 *
 * Since 2026-08-29 the pipes are gone: stdin is a FIFO the child holds `O_RDWR` (so there is no EOF
 * to see) and stdout is a file (so there is no EPIPE to hit). `detach()` therefore does the only
 * thing left worth doing — persist each child's queue and read offset so the NEXT loom can adopt it
 * — and gets out of the way. Driven evidence, real binary, in `spool.ts` and record item 6.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    runner.detach();
    server.stop();
    process.exit(0);
  });
}
