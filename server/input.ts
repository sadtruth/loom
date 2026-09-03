/**
 * The write path: ONE long-lived `claude` child per session, stdin held open (SPEC §Input path).
 *
 * Invariant 1 lives here structurally — this module never opens a transcript file. It spawns the
 * one process that owns the format, writes stream-json user messages to its stdin, and reads
 * stdout only for turn status. The reply reaches the UI through the read path (the tailer sees the
 * binary's appends), which is the entire argument for driving the CLI instead of the SDK.
 *
 * WHY THE CHILD IS PERSISTENT (2026-08-06, the rewrite that made loom affordable). The original
 * shape spawned a fresh `claude --resume` per turn. A fresh process reuses only the TOOLS block
 * from the prompt cache and re-writes the system prompt and the ENTIRE conversation as a fresh
 * cache write, at 2x input price — measured at $3.94 for a single turn on a 400k-token session,
 * against ~$0.20 to read the same context. The tax grew with session length, so loom got more
 * expensive the longer it was useful. Spike evidence (spike-persistent.ts), same child, two turns:
 *
 *     turn 1  cache_read= 17,536   cache_write= 6,625
 *     turn 2  cache_read= 24,161   cache_write=   256    <- read the whole prior prefix
 *
 * The same spike settled the other two questions this design depends on: a user message written to
 * stdin MID-TURN is queued and acted on, and `control_request/interrupt` stops a running turn in
 * milliseconds. So one architectural change buys the cost fix, queued sends, and the stop button —
 * they were never three features, they were one missing property.
 *
 * The permission hook is injected per child via --settings, never installed globally: the child's
 * env carries LOOM_PERMIT_URL, which is both the hook's activation marker and the address it
 * long-polls (SPEC 34).
 */

import { existsSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { WORKING_SILENCE_MS } from "./activity.ts";
import { agyArgs, agyStdinLine, appendShadowTranscriptSync, getAgyConversation, writeAgyConversationSync } from "./agy.ts";
import { AgyFrameTranslator } from "./agy-frames.ts";
import type { AskRule } from "./askrules.ts";
import { asModelId, runnerOf, type RunnerKind } from "./models.ts";
import {
  closeQuietly,
  createSpool,
  dropSpool,
  errPath,
  isOurChild,
  openWriter,
  outPath,
  readMeta,
  spooledSessions,
  writeMeta,
  type SpoolMeta,
} from "./spool.ts";
import { hasUnfinishedBackgroundWork } from "./background-work.ts";
import { PROJECTS_ROOT } from "./projects.ts";
import { Stepper } from "./step.ts";

export type JobState = "running" | "done" | "error";

/**
 * One accepted-but-unanswered message, as the QUEUE knows it (SPEC 138). The text is what the echo
 * draws; `at` is when this server took it, which is what puts the echo where it was sent instead of
 * at the bottom of whatever the child has produced since.
 */
export interface QueuedMessage {
  text: string;
  at: number;
}

export interface JobEvent {
  sessionId: string;
  state: JobState;
  /** Human-readable line for the status bar: cost on success, the failure on error. */
  detail: string | null;
  /** Messages accepted but not yet answered — the composer shows this (SPEC 106). */
  queued: number;
  /**
   * Those same messages, oldest first — the queue's contents, not just its length (SPEC 138). The
   * client used to hold this list itself, which meant a reload had nothing to draw: the message was
   * really in the child's queue and really being answered, with no sign of it anywhere on screen.
   */
  pending: QueuedMessage[];
  /**
   * What the child is doing RIGHT NOW, phrased as an act (`reading tasks.ts`), already quieted by
   * the Stepper. `null` means nothing is known yet — the composer then says plain `working`
   * (SPEC 96).
   */
  step: string | null;
  /**
   * How long `step` has been the shown label, in ms, at the moment this event was built. The client
   * ticks on from there rather than from a wall clock, because a phone's clock and the box's are not
   * the same clock.
   */
  stepMs: number;
}

/**
 * auto — the CLI's auto-mode classifier decides every call, no cards (verified headless
 * 2026-08-05: defaultMode via --settings gives permissionMode "auto" and tools run). The default:
 * tens of cards per working turn made cards-always unusable the first day.
 * cards — every mutating call raises a permit card; the classifier never runs.
 */
export type PermissionStyle = "auto" | "cards";

/**
 * The pickable models and thinking levels (SPEC 49). Both are ALLOWLISTS, not free strings: the
 * value becomes argv for a spawned process, and an unknown one makes the child die with a message
 * nobody asked for. "default" means send no flag at all — the CLI's own default then stands, which
 * is what a device that never touched the picker must get.
 */
export const MODELS = ["default", "opus", "sonnet", "haiku", "fable"] as const;
export const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelChoice = string;
export type EffortChoice = (typeof EFFORTS)[number];

/** Anything not on the list degrades to "default" — a bad pick must not break a send. */
export function asModel(value: unknown): string {
  return asModelId(value);
}

export function asEffort(value: unknown): EffortChoice {
  return EFFORTS.includes(value as EffortChoice) ? (value as EffortChoice) : "default";
}

export interface InputImage {
  mediaType: string;
  data: string;
}

export interface StartRequest {
  sessionId: string;
  /** Continue an existing session (--resume) vs. open a new one (--session-id). */
  resume: boolean;
  cwd: string;
  text: string;
  mode: PermissionStyle;
  model: ModelChoice;
  effort: EffortChoice;
  /**
   * VESTIGIAL since 2026-09-01. It used to decide whether this child loaded `.mcp.json` and its two
   * Playwright browsers, because carrying them was expensive. They are always on now and cost a
   * socket, so nothing reads this — the field stays only because the client still sends it, and
   * removing it from the wire is a separate change.
   */
  browser: boolean;
  images: InputImage[];
  /**
   * Which project this session is on, for the child's own system prompt.
   *
   * Since cores the cwd names the VAULT, not the project, so nothing in the child's environment
   * says what it is working on. It must NOT ride as a prelude in front of his first message: tried
   * that on 2026-08-16 and the stub answered my line instead of his, breaking four journeys — a
   * project identity is context, not something the user said. Constant for a session's whole life,
   * and children are keyed per session, so it never churns a prompt prefix.
   */
  project?: {
    title: string;
    record: string;
    frame?: string | null;
    references?: { title: string; path: string; why: string | null }[];
  } | undefined;
}

export type StartResult =
  | { ok: true; queued: number; pending: QueuedMessage[] }
  | { ok: false; status: 400 | 500; reason: string };

const HOOK_PATH = join(import.meta.dir, "..", "hooks", "permit.ts");

/**
 * How long a child is kept after the turn that last warmed its cache. Keeping it costs memory —
 * each child carries its own MCP servers, browsers included — while dropping it costs the WHOLE
 * conversation re-written on the next turn, because a fresh `claude --resume` reuses only the
 * tools block.
 *
 * The number is not a comfort setting: it is the prompt cache's own lifetime, one hour, refreshed
 * by every read. Twenty minutes threw a still-warm cache away forty minutes early — on 2026-08-12
 * that was four restarts inside a live cache in one session, 446,555 re-written tokens, and 64% of
 * the day's cache writes across all sessions were cold starts.
 */
const IDLE_MS = 60 * 60 * 1000;

/**
 * The floor under `idleDelay`. If the TTL assumption above is ever wrong, holding a child too long
 * costs memory and holding it too briefly costs a conversation — so the error is taken on the side
 * that is merely expensive in RAM.
 */
const MIN_KEEP_MS = 5 * 60 * 1000;

/**
 * When to drop an idle child, counted from the moment its cache prefix was last WRITTEN — the
 * request going out — and not from the moment the answer came back. The two differ by the length
 * of the turn, so a turn with five minutes of tool calls leaves the cache five minutes older than
 * a timer armed at turn end believes it is. Pure, so the arithmetic can be pinned without a clock.
 */
/**
 * The cache lifetime in force, and the only knob a test may move. An hour is not drivable, and the
 * idle path is exactly where the 2026-09-01 loss happened — a session waiting on an hour-long sweep
 * was retired and its subprocess died with it — so that path has to be pinnable end to end against
 * the real Runner, the real timer and a real transcript. Read at CALL time, not at module load,
 * because a test sets it after this file has been imported.
 */
function idleMs(): number {
  const override = Number(process.env["LOOM_IDLE_MS"]);
  return Number.isFinite(override) && override > 0 ? override : IDLE_MS;
}

export function idleDelay(cacheAt: number, now: number): number {
  const span = idleMs();
  // Unchanged in production: the floor is MIN_KEEP_MS, which is well under the hour. It only gives
  // way when a test shortens the span below it, so the override is not swallowed by the floor.
  return Math.max(Math.min(MIN_KEEP_MS, span), cacheAt + span - now);
}

/**
 * Which child to retire when the cap is reached, or null to let the cap YIELD and go over.
 *
 * User, 2026-08-31, after losing a session mid-work: *"You shouldn't kill sessions that have live
 * cache in them, no matter how many. It's not about me looking at something"*. The cap used to
 * choose by least-recently-used alone, so it threw away warm caches — while printing the exact size
 * of the loss in its own retire line, `read 1074591 / write 128761`. `idleDelay` above already
 * refuses to drop a child inside its cache lifetime; this is the same rule at the other call site,
 * which never had it.
 *
 * A child is safe to cut only if it is idle, not already retiring, not waiting on background work
 * it started, AND its cache has gone cold by the same one-hour clock. When nothing qualifies the
 * answer is null: going over the cap costs memory, and cutting a live cache costs the whole
 * conversation re-written on the next turn.
 *
 * `background` arrives as a field rather than being computed here so this stays pure — reading a
 * transcript is the Runner's job (`backgroundWork`), and 2026-09-01 added it because a session
 * holding an hour-long sweep has `queued === 0` and looked exactly like one nobody was using.
 *
 * Pure, like `idleDelay`, so the policy can be pinned without spawning a process.
 */
export function evictionChoice(
  children: Array<{
    id: string;
    queued: number;
    retiring: boolean;
    cacheAt: number;
    lastUsed: number;
    background: boolean;
  }>,
  now: number,
): string | null {
  let chosenId: string | null = null;
  let oldest = Infinity;
  for (const c of children) {
    if (c.queued > 0 || c.retiring || c.background) continue;
    if (now - c.cacheAt < IDLE_MS) continue; // cache still live — never cut, whatever the count
    if (c.lastUsed < oldest) {
      oldest = c.lastUsed;
      chosenId = c.id;
    }
  }
  return chosenId;
}

/**
 * How long a retired child is given to notice its stdin closed before it is signalled. Closing the
 * pipe is a request, and on 2026-08-12 two children from the previous day were still resident
 * having ignored it — the exact memory the `MAX_LIVE` cap exists to bound, leaking around it.
 */
const RETIRE_GRACE_MS = 30 * 1000;

/** Did `promise` settle within `ms`? Used to escalate a retire that the child is ignoring. */
async function settled(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const late = Symbol("late");
  const timer = new Promise<typeof late>((done) => setTimeout(() => done(late), ms));
  return (await Promise.race([promise, timer])) !== late;
}

/** Session ids are UUIDs; a log line wants the head of one, the way git wants the head of a sha. */
function short(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Ceiling on live children. Past this the least-recently-used IDLE child is retired. Without it,
 * opening sessions all evening ends with a dozen resident CLIs and their browsers — the shape that
 * put loom's cgroup at 3.7 GB before this rewrite.
 */
const MAX_LIVE = 4;

/** The repo root — where `.claude/settings.json` and every guard actually live. */
import { isCoreRoot } from "./cores.ts";

const PROJECT_ROOT = resolvePath(import.meta.dir, "..", "..", "..");

/**
 * The project's own hooks, rewritten to absolute paths so they survive a deep cwd.
 *
 * WHY THIS EXISTS (token-cost task 21, measured 2026-08-10). `.claude/settings.json` is discovered
 * from the CWD and does not walk up. Every loom session runs with cwd set to its project record's
 * directory (`main.ts`), which sits below the repo root — so the project's ENTIRE hook set never
 * loaded. Proven by spawning the same child twice through `childArgs`, varying only cwd depth:
 * the repo root gave 12 hook invocations over 6 Bash calls, the record directory gave 0.
 *
 * That silently disabled ~30 gates for loom's whole life, `connguard` among them — the guard that
 * stops a direct connection to the proxy-chain VPS. Each was written as a hook precisely because
 * CLAUDE.md rule 21 says prose does not hold, and each had been prose ever since.
 *
 * The fix was never in doubt once measured: loom's own permit hook is passed inline with an
 * ABSOLUTE path and has always fired at any depth. This does the same for the rest.
 *
 * Read once at module load. The settings string lands in argv and a warm child cannot be handed
 * new argv anyway, so editing `settings.json` needs a loom restart — exactly as the permit hook
 * already does.
 */
function projectHooks(): Record<string, unknown[]> {
  try {
    const raw = readFileSync(join(PROJECT_ROOT, ".claude", "settings.json"), "utf8");
    const hooks = (JSON.parse(raw) as { hooks?: Record<string, unknown[]> }).hooks;
    if (hooks === undefined || hooks === null) return {};
    // Every command is written against $CLAUDE_PROJECT_DIR — the variable that fails here.
    // Substituting the literal root is the whole fix.
    return JSON.parse(JSON.stringify(hooks).replaceAll("$CLAUDE_PROJECT_DIR", PROJECT_ROOT)) as Record<
      string,
      unknown[]
    >;
  } catch {
    // A missing or malformed settings file must not stop a session starting: the guards are
    // worth a great deal, a loom that refuses to run is worth nothing.
    return {};
  }
}

const PROJECT_HOOKS = projectHooks();

/**
 * Settings injected into the child. The hook rides along in BOTH modes (in auto the defer policy
 * short-circuits it, and a future "card only what the classifier denies" will want it in place);
 * auto mode additionally sets the permission mode — through settings, because that is the shape
 * verified to survive headless. Exported for the unit test.
 *
 * `cwd` decides whether the project's hooks are injected. At the repo root the CLI discovers them
 * itself and injecting would fire every guard TWICE; below it, discovery fails and injection is
 * the only thing that makes them run at all.
 */
export function childSettings(mode: PermissionStyle, cwd?: string): string {
  // A cwd that IS a core root needs nothing injected: the CLI finds that core's own settings, and
  // injecting the loom repo's on top would give a work session the personal vault's guards pointed
  // at the personal vault. Only a cwd that is neither the repo root nor a core — a legacy record
  // directory, a fixture — still depends on injection to have any hooks at all.
  const cwdPath = cwd === undefined ? undefined : resolvePath(cwd);
  const needsInjection = cwdPath !== undefined && cwdPath !== PROJECT_ROOT && !isCoreRoot(cwdPath);
  const injected = needsInjection ? PROJECT_HOOKS : {};
  const pre = [
    ...((injected["PreToolUse"] as unknown[] | undefined) ?? []),
    { hooks: [{ type: "command", command: `bun "${HOOK_PATH}"`, timeout: 3600 }] },
  ];
  return JSON.stringify({
    ...(mode === "auto" ? { permissions: { defaultMode: "auto" } } : {}),
    hooks: { ...injected, PreToolUse: pre },
  });
}

/**
 * The Playwright browsers are no longer spawned per child. Two long-lived servers own the two
 * Chrome profiles (systemd user units `playwright-mcp-direct` / `playwright-mcp-fi`, declared in
 * /etc/nixos/home.nix) and every child connects to them over HTTP. See the note on `childArgs`.
 */
const PLAYWRIGHT_ENDPOINTS: ReadonlyArray<{ name: string; port: number; url: string }> = [
  { name: "playwright_direct", port: 8931, url: "http://localhost:8931/mcp" },
  { name: "playwright_fi", port: 8932, url: "http://localhost:8932/mcp" },
];

/**
 * Which endpoints are answering right now, refreshed on a timer rather than read at spawn — a
 * child must never wait on a network round trip to start, and `childArgs` is synchronous.
 *
 * The gate is here because a server that is DOWN at spawn and comes UP later is the one shape that
 * can still flap a live child: the CLI would connect it mid-conversation and the tool list at the
 * head of the prompt would change. A server that was never offered to a child is simply absent for
 * that child's whole life, which costs the browser and costs nothing in cache.
 *
 * Starts optimistic. The units carry `Restart=always`, so "up" is the overwhelmingly likely state,
 * and the first probe lands a second later anyway.
 */
const healthyMcp = new Set<string>(PLAYWRIGHT_ENDPOINTS.map((e) => e.name));

/**
 * A raw TCP connect, deliberately NOT `fetch`. Bun routes every fetch through HTTP_PROXY including
 * ones aimed at localhost, so a fetch probe here answers 503 on a perfectly healthy server unless
 * NO_PROXY happens to be right in loom's own environment. A socket cannot be misrouted.
 */
function portAnswers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const sock = netConnect({ host: "::1", port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      done(ok);
    };
    sock.setTimeout(1500);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

async function probeMcpEndpoints(): Promise<void> {
  for (const endpoint of PLAYWRIGHT_ENDPOINTS) {
    if (await portAnswers(endpoint.port)) healthyMcp.add(endpoint.name);
    else healthyMcp.delete(endpoint.name);
  }
}

void probeMcpEndpoints();
setInterval(() => {
  void probeMcpEndpoints();
}, 20_000).unref();

/**
 * The MCP servers this child gets, as the inline JSON `--mcp-config` takes. Composed here rather
 * than left to `.mcp.json` discovery so that the set is EXPLICIT and identical for every child:
 * discovery pulled in whatever the settings layers happened to agree on that day, including the
 * account-level `claude.ai Google Drive` connector, which drops and retries over the network on its
 * own schedule and flaps the tool list exactly like a dead browser does.
 *
 * `q` rides along only where it can actually run. It is the road into a governed tree (rule 44) and
 * loom children have had no MCP at all since the browsers were switched off, which is why a session
 * in a core has been reaching for the shell wrapper instead.
 */
export function childMcpConfig(cwd?: string): string {
  const servers: Record<string, unknown> = {};
  const cwdPath = cwd === undefined ? undefined : resolvePath(cwd);
  if (cwdPath !== undefined && existsSync(join(cwdPath, "tools/qguard/mcp.ts"))) {
    servers["q"] = { command: "bun", args: ["tools/qguard/mcp.ts"] };
  }
  for (const endpoint of PLAYWRIGHT_ENDPOINTS) {
    if (healthyMcp.has(endpoint.name)) servers[endpoint.name] = { type: "http", url: endpoint.url };
  }
  return JSON.stringify({ mcpServers: servers });
}

/**
 * The child's argv. Pure and exported so the flags can be pinned by tests without spawning:
 * a picked model/effort must appear exactly once, and "default" must add nothing at all.
 *
 * WHY THE BROWSER IS BACK ON, AND WHY IT IS SAFE NOW (2026-09-01). From 2026-08-07 to this change
 * every child ran with a bare `--strict-mcp-config` and no MCP servers at all, because when the two
 * Playwright servers were loaded the tool list at the front of the prompt prefix changed
 * mid-conversation, which invalidates the cache and re-sends the whole conversation as a WRITE
 * (~1.25x) instead of a READ (~0.1x) — about 12x. One flap on 2026-08-07 wrote 141,405 tokens on a
 * single call. The tool SCHEMAS were never the cost: the CLI defers them, and real sessions start
 * at a measured 37.5k tokens over 61 archived sessions.
 *
 * What actually changed the tool list was the servers DYING, and the reason they died was found on
 * 2026-09-01. The nixpkgs `playwright-mcp` wrapper force-exports PLAYWRIGHT_MCP_ISOLATED=1 whenever
 * the ENV VAR PLAYWRIGHT_MCP_USER_DATA_DIR is unset — it reads the env var, not the --user-data-dir
 * flag — and isolated mode plus a userDataDir is a hard startup crash. The MCP logs hold 156 of
 * those between 2026-07-14 and 2026-08-16, each one a dead server. The second mode was contention:
 * a child per session times two servers, all pointed at one Chrome profile, so the extra ones got
 * "Browser is already in use for <profile>" — reproduced on 2026-09-01, and it turns out to be a
 * tool-level error rather than a flap, but it made the browser useless in every core but one.
 *
 * Both modes are properties of spawning a server per child, so the servers are no longer spawned
 * per child. Two systemd user units own the two Chrome profiles and every child connects to them
 * over HTTP: connecting costs a socket, nothing is launched, no profile is contended, and a server
 * outliving its client cannot take the client's tool list with it. Two concurrent children both
 * driving the browser were verified working on 2026-09-01, which the old shape could not do at all.
 *
 * `--strict-mcp-config` stays, but now it pairs with an explicit `--mcp-config`: the set of servers
 * is composed in `childMcpConfig` instead of discovered. Discovery was never controllable — a
 * settings-level `disabledMcpjsonServers` left all 46 tools loaded and `--setting-sources` changed
 * nothing — and it also dragged in the account-level `claude.ai Google Drive` connector, a second
 * flap source that drops and retries over the network on its own schedule.
 */
export function childArgs(bin: string, req: StartRequest): string[] {
  return [
    bin,
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--settings",
    childSettings(req.mode, req.cwd),
    "--strict-mcp-config",
    "--mcp-config",
    childMcpConfig(req.cwd),
    ...(req.model === "default" ? [] : ["--model", req.model]),
    ...(req.effort === "default" ? [] : ["--effort", req.effort]),
    ...(req.project === undefined
      ? []
      : [
          "--append-system-prompt",
          `You are working on the project "${req.project.title}". Its record is ${req.project.record}. ` +
            `Your working directory is this core's root, not the project's own folder — the project is ` +
            `named by this sentence, not by where you are standing.` +
            (req.project.references !== undefined && req.project.references.length > 0
              ? `\n\nConnected projects:\n` +
                req.project.references
                  .map((r) => `- ${r.title} (${r.path})${r.why !== null ? `: ${r.why}` : ""}`)
                  .join("\n")
              : "") +
            (req.project.frame !== undefined && req.project.frame !== null
              ? `\n\nThe record's frame, inlined so you do not have to spend a turn fetching it — ` +
                `open the record itself for the work items and anything deeper:\n\n${req.project.frame}`
              : ""),
        ]),
    ...(req.resume ? ["--resume", req.sessionId] : ["--session-id", req.sessionId]),
  ];
}

/**
 * The spawn-shaping choices, as one string. A child is reusable only for turns that would have
 * spawned it identically — model, thinking level and permission style are all argv, so changing one
 * means a new process and therefore one re-written prefix (SPEC 107). Comparing a fingerprint beats
 * comparing four fields at four call sites. Exported for the unit test: a switch that reached argv
 * but not the fingerprint would be honoured on a cold child and silently ignored on a warm one,
 * which is the worst of both.
 *
 * The browser switch left this on 2026-09-01 along with its effect on argv. Keeping it here would
 * have retired a perfectly good child every time the toggle moved, for no difference in the child.
 */
export function fingerprint(req: StartRequest): string {
  return `${req.model}|${req.effort}|${req.mode}|${req.cwd}`;
}

/**
 * A live child, whether loom spawned it or found it. The two differ in exactly one place — how you
 * wait for it and how you signal it — so that difference is all this abstracts. Everything else
 * (the FIFO, the spooled stdout, the meta file) is identical by construction: an adopted child was
 * spawned through this same code by the previous loom.
 */
interface Handle {
  pid: number;
  /** Resolves when the process is gone; the code is best-effort for an adopted child. */
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

function ownHandle(proc: Bun.Subprocess): Handle {
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: (signal?: NodeJS.Signals) => proc.kill(signal === "SIGKILL" ? 9 : 15),
  };
}

/**
 * A child this process did not spawn. There is no `wait()` to be had for a non-child pid, so the
 * exit is POLLED — the same identity check adoption used, asked again every few seconds. It is only
 * ever consulted to report a death, so a few seconds of lag costs nothing.
 */
function adoptedHandle(pid: number, sessionId: string): Handle {
  const exited = new Promise<number>((resolve) => {
    const timer = setInterval(() => {
      if (isOurChild(pid, sessionId)) return;
      clearInterval(timer);
      resolve(0);
    }, ADOPTED_POLL_MS);
    // A poll that keeps the process alive would stop loom from ever exiting cleanly.
    timer.unref?.();
  });
  return {
    pid,
    exited,
    kill: (signal?: NodeJS.Signals) => {
      try {
        process.kill(pid, signal ?? "SIGTERM");
      } catch {
        // Already gone. The poll above will notice.
      }
    },
  };
}

/** How often an adopted child's liveness is re-asked, and how long a spool poll sleeps. */
const ADOPTED_POLL_MS = 3000;
const SPOOL_POLL_MS = 60;

interface Child {
  handle: Handle;
  /** This session's spool directory — the FIFO, the stdout file, the meta. */
  dir: string;
  /** Where the child was spawned. Half of its transcript's path, which is how `backgroundWork` reads it. */
  cwd: string;
  /** Transcript size at the last background-work read, so a sweep re-reads only when it has grown. */
  bgSize: number;
  /** The last background-work answer, valid while the transcript has not grown. */
  bgAnswer: boolean;
  /** The write end of the FIFO. `O_RDWR`, so it neither blocks on open nor ever sees EPIPE. */
  stdinFd: number;
  /** The spawn shape this child was created with; a send that disagrees must respawn. */
  spec: string;
  /** Turns accepted and not yet answered by a `result` frame. Always `pending.length`. */
  queued: number;
  /** Those turns' own text, oldest first — the queue as content, so a reloading device can see it. */
  pending: QueuedMessage[];
  lastUsed: number;
  /**
   * When this child last SENT a turn — the moment its cache prefix was written, and so the moment
   * the hour starts running. Distinct from `lastUsed`, which moves again when the answer lands.
   */
  cacheAt: number;
  /** When it was spawned, so a retire line can say how much of an hour was actually used. */
  bornAt: number;
  /** When this child last received any frame on stdout, used to detect stale queues. */
  lastFrameAt: number;
  /** The last turn's cache split, for the retire line — the damage a restart is about to cost. */
  lastCache: string;
  /** Bytes of the stdout spool the poller has taken, INCLUDING a half-arrived trailing line. */
  readOffset: number;
  /**
   * Bytes up to the last COMPLETE frame. This, never `readOffset`, is what the meta records: an
   * adopting loom resuming inside a line would drop that frame, and one of them is the `result`
   * that ends a turn.
   */
  frameOffset: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** In-flight control requests, keyed by request_id, resolved by the matching response. */
  controls: Map<string, (ok: boolean) => void>;
  /** Set once the child is on its way out, so a late frame cannot resurrect it. */
  retiring: boolean;
  /** Derives and quiets the step in flight from the intermediate frames (SPEC 96). */
  stepper: Stepper;
  /** Which binary/harness this child is running. */
  runner: RunnerKind;
  /** Pure translator for agy stream-json frames -> Claude transcript JSONL rows. */
  translator?: AgyFrameTranslator;
  /** Cumulative token usage seen from agy result frames. */
  cumulativeTokens?: { in: number; out: number; read: number };
}

export class Runner {
  /**
   * Text to put in front of the next message of a session — the recap, and nothing else so far.
   * It waits here rather than being sent on its own, because a message of its own would be a turn
   * and would be answered (requirement 175). Cleared by the send that carries it, so it is injected
   * exactly once however many turns follow.
   */
  private readonly preludes = new Map<string, string>();

  /**
   * Hand the next send of this session something to carry. Nothing to say is not something to say:
   * an empty prelude used to ride in front of his first message as an empty reminder block, which
   * costs a turn's context to communicate that a recap found nothing.
   */
  carry(sessionId: string, text: string): void {
    if (text.trim().length === 0) return;
    this.preludes.set(sessionId, text);
  }

  /** Whether a session is still waiting to carry one — the block's "not yet in context" state. */
  carrying(sessionId: string): boolean {
    return this.preludes.has(sessionId);
  }

  private readonly children = new Map<string, Child>();

  /**
   * His standing `permissions.ask` rules (SPEC 219). Read once at startup and handed to each child's
   * hook. Empty is the old behaviour: `defer` cards nothing.
   */
  private askRules: AskRule[] = [];

  constructor(
    private readonly bin: string,
    private readonly permitUrl: string,
    private readonly port: number,
    private readonly onEvent: (event: JobEvent) => void,
    private readonly stateDir: string = Bun.env["LOOM_STATE"] ?? join(import.meta.dir, "..", "state"),
  ) {}

  /** Called once at startup, after the settings file has been read. */
  setAskRules(rules: readonly AskRule[]): void {
    this.askRules = [...rules];
  }

  /** A turn is in flight for this session (used by the WS attach to render the status). */
  running(sessionId: string): boolean {
    return (this.children.get(sessionId)?.queued ?? 0) > 0;
  }

  /**
   * True when the runner claims a turn is in flight (`queued > 0`), the transcript says the newest
   * row ended a turn, and no stdout frame has arrived for WORKING_SILENCE_MS (SPEC 267).
   *
   * Both conditions are load-bearing: a long Bash command emits no frames but its newest row is
   * a tool_use, so it stays running. When stale, the child is reconciled immediately (SPEC 268).
   */
  stale(sessionId: string, transcriptSaysEnded: boolean, now: number = Date.now()): boolean {
    const child = this.children.get(sessionId);
    if (child === undefined || child.queued === 0) return false;
    if (!transcriptSaysEnded) return false;
    if (now - child.lastFrameAt < WORKING_SILENCE_MS) return false;

    const leaked = child.queued;
    child.pending = [];
    child.queued = 0;
    child.stepper.reset();
    this.persist(sessionId, child);
    this.onEvent({
      sessionId,
      state: "done",
      detail: `reconciled stale queue (${leaked} turn(s) cleared)`,
      queued: 0,
      pending: [],
      step: null,
      stepMs: 0,
    });
    this.armIdle(sessionId, child);
    console.log(
      `[loom] reconciled stale child for ${short(sessionId)} — cleared ${leaked} queued turn(s) after silence`,
    );
    return true;
  }

  queued(sessionId: string): number {
    return this.children.get(sessionId)?.queued ?? 0;
  }

  /**
   * What is in this session's queue right now — what a device attaching or RELOADING mid-turn needs
   * to draw its echoes from (SPEC 138). A copy, so a caller cannot edit the child's own list.
   */
  pending(sessionId: string): QueuedMessage[] {
    return [...(this.children.get(sessionId)?.pending ?? [])];
  }

  /** The quieted step and its age — what a device attaching MID-TURN needs to draw (SPEC 96). */
  step(sessionId: string): { step: string | null; stepMs: number } {
    const stepper = this.children.get(sessionId)?.stepper;
    return { step: stepper?.label() ?? null, stepMs: stepper?.sinceMs() ?? 0 };
  }

  /**
   * Take back the children the previous loom left running (SPEC 255). Called once, at boot, before
   * anything is served.
   *
   * The three answers a spool directory can get:
   *  - the pid is gone, or belongs to something else now — the directory is swept;
   *  - the pid is ours but its cache is older than the hour a child is kept FOR — there is nothing
   *    left to save, so it is signalled and swept, which is also what stops an abandoned loom from
   *    leaking children forever;
   *  - otherwise it is adopted: the FIFO is reopened, the stdout spool is tailed from where the
   *    previous loom stopped reading, and any turn that finished in the gap is reported now.
   */
  adopt(): void {
    for (const { dir, meta } of spooledSessions(this.port)) {
      if (!isOurChild(meta.pid, meta.sessionId)) {
        dropSpool(dir);
        continue;
      }
      const coldFor = Date.now() - meta.cacheAt;
      if (coldFor > IDLE_MS + MIN_KEEP_MS) {
        console.log(
          `[loom] ${short(meta.sessionId)} was left behind and its cache is ${Math.round(coldFor / 60000)}m old — SIGTERM`,
        );
        try {
          process.kill(meta.pid, "SIGTERM");
        } catch {
          // Gone between the check and the signal; the sweep below is the point either way.
        }
        dropSpool(dir);
        continue;
      }
      this.reattach(dir, meta);
    }
  }

  private reattach(dir: string, meta: SpoolMeta): void {
    let stdinFd: number;
    try {
      stdinFd = openWriter(dir);
    } catch (error) {
      console.log(`[loom] could not reopen ${short(meta.sessionId)}'s pipe — ${String(error)}`);
      dropSpool(dir);
      return;
    }
    const model = meta.spec.split("|")[0] ?? "default";
    const runner = runnerOf(model);
    const child = this.makeChild(meta.sessionId, {
      handle: adoptedHandle(meta.pid, meta.sessionId),
      dir,
      // An adopted child's cwd survives only inside its spawn fingerprint; the meta carries no other copy.
      cwd: cwdOfSpec(meta.spec),
      stdinFd,
      spec: meta.spec,
      pending: meta.pending,
      lastUsed: meta.lastUsed,
      cacheAt: meta.cacheAt,
      bornAt: meta.bornAt,
      lastCache: meta.lastCache,
      readOffset: meta.readOffset,
      runner,
    });
    console.log(
      `[loom] adopted ${short(meta.sessionId)} — pid ${meta.pid} · ${child.queued} turn(s) still queued` +
        ` · ${Math.round((Date.now() - meta.cacheAt) / 1000)}s since its cache was written`,
    );
    this.children.set(meta.sessionId, child);
    void this.pump(meta.sessionId, child);
    void this.reap(meta.sessionId, child);
    if (child.queued === 0) this.armIdle(meta.sessionId, child);
  }

  /**
   * Accept one turn. Unlike the old shape this never refuses because a turn is already running —
   * the CLI queues stdin messages and answers them in order, which is the whole point of holding
   * the pipe open (SPEC 33, rewritten).
   */
  send(req: StartRequest): StartResult {
    if (req.text.trim().length === 0 && req.images.length === 0) {
      return { ok: false, status: 400, reason: "empty message" };
    }

    let child = this.children.get(req.sessionId);
    if (child !== undefined && child.spec !== fingerprint(req)) {
      // Model / effort / permission style changed: those are argv, so the live child cannot serve
      // this turn. Retire it and pay one re-written prefix, rather than silently ignoring the pick.
      this.retire(req.sessionId, "respawn for a new model or thinking level");
      child = undefined;
    }

    if (child === undefined) {
      const spawned = this.spawn(req);
      if (!spawned.ok) return spawned;
      child = spawned.child;
    }

    const runner = runnerOf(req.model);
    try {
      if (runner === "agy") {
        const prelude = this.preludes.get(req.sessionId);
        if (prelude !== undefined) {
          this.preludes.delete(req.sessionId);
        }
        const fullText = prelude !== undefined && prelude.length > 0 ? `${prelude}\n\n${req.text}` : req.text;
        if (child.translator !== undefined) {
          child.translator.feedUserPrompt(fullText);
        }
        writeLine(child.stdinFd, agyStdinLine(fullText));
      } else {
        // Images first, text after — the shape verified by spike (the model described the pixel).
        const content: unknown[] = req.images.map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        }));
        // The recap rides in FRONT of his words, in the same turn (requirement 175). Its own text block,
        // not folded into his: `detectMeta` reads whole rows, and the client hides a reminder block
        // wherever it sits, so this reaches the model and never reaches the screen. One turn means no
        // assistant reply of its own (requirement 175), and once sent it lives in the cached prefix.
        const prelude = this.preludes.get(req.sessionId);
        if (prelude !== undefined) {
          this.preludes.delete(req.sessionId);
          content.push({ type: "text", text: prelude });
        }
        if (req.text.trim().length > 0) content.push({ type: "text", text: req.text });

        writeLine(child.stdinFd, JSON.stringify({ type: "user", message: { role: "user", content } }));
      }
    } catch (error) {
      // A dead pipe means the child went away between our check and this write.
      this.retire(req.sessionId, "child pipe closed");
      return { ok: false, status: 500, reason: `child not accepting input: ${String(error)}` };
    }

    // The queue is a list, and its length is the count — never two facts that can disagree.
    child.pending.push({ text: req.text, at: Date.now() });
    child.queued = child.pending.length;
    child.lastUsed = Date.now();
    // The request is out, so the cache prefix is being written NOW. Everything about when to drop
    // this child is counted from here, not from whenever the answer gets back.
    child.cacheAt = Date.now();
    this.armIdle(req.sessionId, child);
    // A turn boundary, so the meta is rewritten: this is the moment a restart would otherwise lose
    // the fact that a turn is in flight at all.
    this.persist(req.sessionId, child);
    this.onEvent({
      sessionId: req.sessionId,
      state: "running",
      detail: null,
      queued: child.queued,
      pending: [...child.pending],
      // A turn that has only just been accepted has no step yet; the first frame gives it one.
      ...this.step(req.sessionId),
    });
    return { ok: true, queued: child.queued, pending: [...child.pending] };
  }

  /**
   * Stop the turn in flight. The CLI answers a control request in milliseconds (spike: 7ms) and
   * ends the current turn with `error_during_execution`; anything queued behind it still runs, so
   * an interrupt is "stop THIS", never "forget everything I asked".
   */
  async interrupt(sessionId: string): Promise<boolean> {
    const child = this.children.get(sessionId);
    if (child === undefined || child.queued === 0) return false;
    const id = `loom_${crypto.randomUUID().slice(0, 8)}`;
    const answered = new Promise<boolean>((resolve) => {
      child.controls.set(id, resolve);
      setTimeout(() => {
        if (child.controls.delete(id)) resolve(false);
      }, 5000);
    });
    try {
      writeLine(child.stdinFd, JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "interrupt" } }));
    } catch {
      child.controls.delete(id);
      return false;
    }
    return await answered;
  }

  /**
   * Leave every child RUNNING and write down where it got to — what loom does on its way out
   * (SPEC 255). This is the opposite of `shutdown()` and it is deliberate: a restart to deploy a
   * fix used to end whatever User was in the middle of, three times in eleven days.
   */
  detach(): void {
    for (const [id, child] of this.children) {
      this.persist(id, child);
      closeQuietly(child.stdinFd);
    }
    if (this.children.size > 0) {
      console.log(`[loom] detaching from ${this.children.size} live session(s) — they keep working`);
    }
    this.children.clear();
  }

  /** Close every child, for real. Kept for the test hatch and for a deliberate wind-down. */
  shutdown(): void {
    for (const id of [...this.children.keys()]) this.retire(id, "loom shutting down");
  }

  /**
   * TEST-ONLY escape hatch: force one session's child to retire without a real trigger (a model
   * change, a dead pipe, eviction, `shutdown()`). Gated the same way as `/api/test/drop-sockets` —
   * the driven suite needs a way to reproduce "a retire happened while the socket was severed"
   * (SPEC requirement for the reconnect race, step 6) without contriving one of those four through
   * the UI, and the caller (`server/main.ts`) refuses this outside `NODE_ENV=test`.
   */
  testRetire(sessionId: string, why: string): void {
    this.retire(sessionId, why);
  }

  /**
   * TEST-ONLY: is there still a live child for this session? `running()` answers about a TURN, not
   * about the process, so it cannot tell a retired child from an idle one — and that difference is
   * the whole subject of the background-work rule.
   */
  testLive(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  /**
   * TEST-ONLY: detach from the children the way a restart does, so a driven journey can reach the
   * state a `systemctl restart` leaves without killing the server Playwright is holding.
   */
  testDetach(): void {
    this.detach();
  }

  private makeChild(
    sessionId: string,
    seed: {
      handle: Handle;
      dir: string;
      cwd: string;
      stdinFd: number;
      spec: string;
      pending: QueuedMessage[];
      lastUsed: number;
      cacheAt: number;
      bornAt: number;
      lastFrameAt?: number;
      lastCache: string;
      readOffset: number;
      runner?: RunnerKind;
    },
  ): Child {
    const runner = seed.runner ?? runnerOf(seed.spec.split("|")[0] ?? "default");
    const cwd = seed.cwd;
    const child: Child = {
      handle: seed.handle,
      dir: seed.dir,
      cwd: seed.cwd,
      bgSize: -1,
      bgAnswer: false,
      stdinFd: seed.stdinFd,
      spec: seed.spec,
      queued: seed.pending.length,
      pending: [...seed.pending],
      lastUsed: seed.lastUsed,
      cacheAt: seed.cacheAt,
      bornAt: seed.bornAt,
      lastFrameAt: seed.lastFrameAt ?? seed.lastUsed ?? Date.now(),
      lastCache: seed.lastCache,
      readOffset: seed.readOffset,
      frameOffset: seed.readOffset,
      idleTimer: null,
      controls: new Map(),
      retiring: false,
      runner,
      translator: runner === "agy" ? new AgyFrameTranslator({ sessionId, cwd }) : undefined,
      // The step is pushed the moment it changes — a floored label is already slow enough without
      // waiting for a poll on top of it.
      stepper: new Stepper((label) => {
        if (child.queued === 0) return; // a straggling frame after the turn landed says nothing
        this.onEvent({
          sessionId,
          state: "running",
          detail: null,
          queued: child.queued,
          pending: [...child.pending],
          step: label,
          stepMs: 0,
        });
      }),
    };
    return child;
  }

  private spawn(req: StartRequest): { ok: true; child: Child } | { ok: false; status: 500; reason: string } {
    this.evictIfCrowded();
    let dir: string;
    let stdinFd: number;
    let outFd: number;
    let errFd: number;
    try {
      dir = createSpool(this.port, req.sessionId);
      // THE WHOLE MECHANISM, in three file descriptors (SPEC 255, and `spool.ts` for the evidence).
      // fd 0 is a FIFO opened O_RDWR and inherited, so the child holds a writer on its own stdin and
      // a dead loom is not end-of-file. fd 1 and 2 are plain files, so a write after loom is gone is
      // not EPIPE. Loom reads the same file back by byte offset, exactly as it tails a transcript.
      stdinFd = openWriter(dir);
      outFd = openSync(outPath(dir), "a");
      errFd = openSync(errPath(dir), "a");
    } catch (error) {
      return { ok: false, status: 500, reason: `could not make the session's spool: ${String(error)}` };
    }

    const runner = runnerOf(req.model);
    let proc: Bun.Subprocess;
    try {
      if (runner === "agy") {
        const convId = req.resume ? getAgyConversation(req.sessionId, this.stateDir) : null;
        if (req.resume && convId === null) {
          const warning =
            "this Gemini session's conversation id is missing — starting a new conversation, so it will not remember what came before";
          this.onEvent({
            sessionId: req.sessionId,
            state: "error",
            detail: warning,
            queued: 0,
            pending: [],
            step: null,
            stepMs: 0,
          });
          const breakRow = JSON.stringify({
            sessionId: req.sessionId,
            uuid: crypto.randomUUID(),
            parentUuid: null,
            type: "system",
            timestamp: new Date().toISOString(),
            cwd: req.cwd,
            message: {
              role: "system",
              content: [{ type: "text", text: warning }],
            },
          });
          appendShadowTranscriptSync(req.cwd, req.sessionId, [breakRow]);
        }
        const argv = agyArgs(req, convId);
        proc = Bun.spawn(argv, {
          cwd: req.cwd,
          stdin: stdinFd,
          stdout: outFd,
          stderr: errFd,
          env: {
            ...process.env,
            NO_PROXY: "localhost,127.0.0.1,::1",
            no_proxy: "localhost,127.0.0.1,::1",
          },
        });
      } else {
        proc = Bun.spawn(childArgs(this.bin, req), {
          cwd: req.cwd,
          stdin: stdinFd,
          stdout: outFd,
          stderr: errFd,
          env: {
            ...process.env,
            // The MCP browsers live on localhost. Node and Bun both route through HTTP_PROXY even
            // for 127.0.0.1 unless NO_PROXY says otherwise, and this box exports a global proxy, so
            // without these two the child's HTTP MCP connection dies at a proxy that has no idea
            // what :8931 is.
            NO_PROXY: "localhost,127.0.0.1,::1",
            no_proxy: "localhost,127.0.0.1,::1",
            LOOM_PERMIT_URL: this.permitUrl,
            // Auto mode does not card for ordinary work: the hook defers and the classifier decides.
            LOOM_PERMIT_POLICY: req.mode === "auto" ? "defer" : "cards",
            // …except for the rules he wrote himself (SPEC 219). `defer` used to mean "no cards at
            // all", so a tool matching one of his `permissions.ask` rules was refused by the CLI with
            // nothing on screen — headless, it has no way to prompt. These are HIS patterns, read from
            // the settings the child runs under; loom only recognises a match so the question reaches
            // a screen he can answer. An empty value keeps the old behaviour exactly.
            LOOM_PERMIT_ASK: JSON.stringify(this.askRules),
            LOOM_PERMIT_HOME: homedir(),
          },
        });
      }
    } catch (error) {
      closeQuietly(stdinFd);
      closeQuietly(outFd);
      closeQuietly(errFd);
      dropSpool(dir);
      return { ok: false, status: 500, reason: `spawn failed: ${String(error)}` };
    }
    // Loom's own copies of the child's output ends are done with; the child holds them now. Its
    // stdin fd stays open here — that is the pipe every send is written to.
    closeQuietly(outFd);
    closeQuietly(errFd);

    const now = Date.now();
    const child = this.makeChild(req.sessionId, {
      handle: ownHandle(proc),
      dir,
      cwd: req.cwd,
      stdinFd,
      spec: fingerprint(req),
      pending: [],
      lastUsed: now,
      cacheAt: now,
      bornAt: now,
      lastCache: "no turn yet",
      readOffset: 0,
      runner,
    });
    this.children.set(req.sessionId, child);
    this.persist(req.sessionId, child);
    void this.pump(req.sessionId, child);
    void this.reap(req.sessionId, child);
    return { ok: true, child };
  }

  /**
   * Clear a child's spool — but only while it is still THAT child's.
   *
   * The directory is named for the session, so a respawn (a new model, a new thinking level) makes
   * a fresh one at the same path while the old child is still being signalled. `hardStop` resumes
   * up to a minute later and would otherwise delete the LIVE child's FIFO and stdout file out from
   * under it: the turn kept running on the unlinked fds and loom, polling a path that no longer
   * existed, showed `stop` forever. Found by `journey2-input` on 2026-08-29, which is what that pin
   * is for.
   */
  private dropIfStillOurs(dir: string, pid: number): void {
    const meta = readMeta(dir);
    if (meta === null || meta.pid !== pid) return;
    dropSpool(dir);
  }

  /** Write down what a loom that did not spawn this child would need to take it over. */
  private persist(sessionId: string, child: Child): void {
    try {
      writeMeta(child.dir, {
        sessionId,
        pid: child.handle.pid,
        port: this.port,
        spec: child.spec,
        bornAt: child.bornAt,
        cacheAt: child.cacheAt,
        lastUsed: child.lastUsed,
        lastCache: child.lastCache,
        pending: [...child.pending],
        readOffset: child.frameOffset,
      });
    } catch (error) {
      // Losing the meta costs the NEXT restart an adoption, never this session's turn.
      console.log(`[loom] could not record ${short(sessionId)}'s spool — ${String(error)}`);
    }
  }

  /**
   * Read the spooled stdout as it grows, by byte offset — the same trick the transcript tailer uses,
   * and the reason turn status now survives a restart. The old shape held `proc.stdout` as a stream,
   * which is exactly the pipe that died with loom.
   *
   * Line splitting is done in BYTES rather than on a decoded string, so `frameOffset` — the number
   * an adopting loom resumes from — is always a real frame boundary. Resuming inside a line would
   * silently drop that frame, and one of them is the `result` that ends a turn.
   */
  private async pump(sessionId: string, child: Child): Promise<void> {
    let tail = new Uint8Array(0);
    const decoder = new TextDecoder();
    const path = outPath(child.dir);
    for (;;) {
      if (this.children.get(sessionId) !== child || child.retiring) return;
      try {
        const file = Bun.file(path);
        const size = file.size;
        if (size < child.readOffset) {
          // The spool was replaced under us — a new child for the same session. Start over.
          child.readOffset = 0;
          child.frameOffset = 0;
          tail = new Uint8Array(0);
        } else if (size > child.readOffset) {
          const chunk = new Uint8Array(await file.slice(child.readOffset, size).arrayBuffer());
          child.readOffset += chunk.byteLength;
          let buffer: Uint8Array;
          if (tail.byteLength === 0) {
            buffer = chunk;
          } else {
            buffer = new Uint8Array(tail.byteLength + chunk.byteLength);
            buffer.set(tail, 0);
            buffer.set(chunk, tail.byteLength);
          }
          let start = 0;
          for (let i = 0; i < buffer.byteLength; i++) {
            if (buffer[i] !== 0x0a) continue;
            if (i > start) this.onFrame(sessionId, child, decoder.decode(buffer.subarray(start, i)));
            start = i + 1;
          }
          // Copied rather than a view: a subarray keeps the whole chunk alive, and the tail is
          // at most one unfinished line.
          tail = new Uint8Array(buffer.subarray(start));
          child.frameOffset = child.readOffset - tail.byteLength;
        }
      } catch {
        // The spool went away with the child; `reap` reports the exit.
      }
      await new Promise((done) => setTimeout(done, SPOOL_POLL_MS));
    }
  }

  private onFrame(sessionId: string, child: Child, line: string): void {
    child.lastFrameAt = Date.now();
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Non-JSON stdout noise is not a failure.
    }

    if (child.runner === "agy") {
      const event = row["event"];
      if (event === "init") {
        const convId = typeof row["conversation_id"] === "string" ? row["conversation_id"] : undefined;
        if (convId !== undefined) {
          writeAgyConversationSync(sessionId, convId, this.stateDir);
        }
      }

      if (child.translator !== undefined) {
        const translated = child.translator.feed(row);
        if (translated.length > 0) {
          appendShadowTranscriptSync(child.cwd, sessionId, translated);
        }
      }

      if (event === "step_update") {
        const su = row["step_update"] as Record<string, unknown> | undefined;
        if (su !== undefined) {
          const stepType = su["step_type"];
          if (stepType === "tool" && typeof su["tool_name"] === "string") {
            const toolInfo = su["tool_info"] as Record<string, unknown> | undefined;
            child.stepper.feed({
              type: "assistant",
              message: {
                content: [{ type: "tool_use", name: su["tool_name"], input: toolInfo?.["parameters"] ?? {} }],
              },
            });
          } else if (stepType === "agent_response") {
            const usage = su["usage"] as Record<string, unknown> | undefined;
            const thinking = Number(usage?.["thinking_tokens"] ?? 0);
            if (thinking > 0) {
              child.stepper.feed({
                type: "system",
                subtype: "thinking_tokens",
                estimated_tokens_delta: thinking,
              });
            }
            if (typeof su["text_delta"] === "string" && su["text_delta"].length > 0) {
              child.stepper.feed({ type: "assistant", message: { content: [{ type: "text" }] } });
            }
          }
        }
        return;
      }

      if (event !== "result") {
        return;
      }

      // One `result` per turn in agy
      child.stepper.reset();
      child.pending.shift();
      child.queued = child.pending.length;
      child.lastUsed = Date.now();
      this.armIdle(sessionId, child);

      const res = row["result"] as Record<string, unknown> | undefined;
      const convId = typeof res?.["conversation_id"] === "string" ? res["conversation_id"] : undefined;
      if (convId !== undefined) {
        writeAgyConversationSync(sessionId, convId, this.stateDir);
      }

      const usage = res?.["usage"] as Record<string, unknown> | undefined;
      const rawIn = Number(usage?.["input_tokens"] ?? 0);
      const rawOut = Number(usage?.["output_tokens"] ?? 0);
      const rawRead = Number(usage?.["cache_read_tokens"] ?? 0);
      const prev = child.cumulativeTokens ?? { in: 0, out: 0, read: 0 };
      const inTok = Math.max(0, rawIn - prev.in);
      const outTok = Math.max(0, rawOut - prev.out);
      const readTok = Math.max(0, rawRead - prev.read);
      child.cumulativeTokens = { in: rawIn, out: rawOut, read: rawRead };
      child.lastCache = `in ${inTok} / out ${outTok}${readTok > 0 ? ` / read ${readTok}` : ""}`;
      this.persist(sessionId, child);

      const failed = res?.["status"] === "ERROR";
      const errDetail = typeof res?.["error"] === "string" ? res["error"] : "error";
      this.onEvent({
        sessionId,
        state: failed ? "error" : "done",
        detail: failed ? errDetail : `done · ${inTok + outTok} tokens`,
        queued: child.queued,
        pending: [...child.pending],
        step: null,
        stepMs: 0,
      });
      return;
    }

    if (row["type"] === "control_response") {
      const response = row["response"] as Record<string, unknown> | undefined;
      const id = response?.["request_id"];
      if (typeof id === "string") {
        const settle = child.controls.get(id);
        if (settle !== undefined) {
          child.controls.delete(id);
          settle(response?.["subtype"] === "success");
        }
      }
      return;
    }

    if (row["type"] !== "result") {
      // Everything else used to be dropped here, which is exactly why a turn in flight looked
      // identical to a dead one: the frames that name the work were parsed and thrown away (SPEC 96).
      child.stepper.feed(row);
      return;
    }

    // One `result` per turn — this is the only reliable turn boundary the CLI gives us.
    child.stepper.reset();
    // The answered turn is the OLDEST one in the queue — the CLI answers them in the order it took
    // them, so the head leaves and whatever is behind it becomes the turn in flight.
    child.pending.shift();
    child.queued = child.pending.length;
    child.lastUsed = Date.now();
    // The turn that just ended WROTE a cache prefix, whoever started it. `cacheAt` used to move only
    // in `send()`, so a turn loom did not originate — a background-task notification, a subagent
    // finishing — left loom believing the cache was as old as the last thing IT sent. On 2026-09-01
    // that made the retire line say "3600s since its cache was written" about a cache written 15
    // minutes earlier, and the idle timer fired 45 minutes early on its own terms.
    child.cacheAt = Date.now();
    this.armIdle(sessionId, child);

    const usage = row["usage"] as Record<string, unknown> | undefined;
    const cost = typeof row["total_cost_usd"] === "number" ? ` · $${(row["total_cost_usd"] as number).toFixed(2)}` : "";
    const subtype = typeof row["subtype"] === "string" ? row["subtype"] : "done";
    // Surface cache reuse in the status line: this rewrite exists because it was invisible before.
    const read = Number(usage?.["cache_read_input_tokens"] ?? 0);
    const write = Number(usage?.["cache_creation_input_tokens"] ?? 0);
    const cache = read + write > 0 ? ` · cache ${Math.round((read / (read + write)) * 100)}% reused` : "";
    child.lastCache = `read ${read} / write ${write}`;
    // The other turn boundary: the queue just changed and so did how far loom has read. A restart
    // between here and the next send must not replay this turn or forget it landed.
    this.persist(sessionId, child);

    const failed = row["is_error"] === true || subtype === "error_during_execution";
    this.onEvent({
      sessionId,
      state: failed ? "error" : "done",
      detail: `${subtype}${cost}${cache}`,
      queued: child.queued,
      pending: [...child.pending],
      step: null,
      stepMs: 0,
    });
  }

  /** Wait the child out; report an unexpected death so the UI never shows a turn that cannot land. */
  private async reap(sessionId: string, child: Child): Promise<void> {
    const code = await child.handle.exited;
    if (this.children.get(sessionId) !== child) return; // detached, retired, or replaced
    this.children.delete(sessionId);
    if (child.idleTimer !== null) clearTimeout(child.idleTimer);
    closeQuietly(child.stdinFd);
    for (const settle of child.controls.values()) settle(false);
    child.controls.clear();
    // `child.retiring` used to mean "say nothing — this exit was requested", back when `retire()`
    // itself said nothing either: the whole retirement was silent. Since `retire()` now emits the
    // dropped-turn event ITSELF (above), this guard's job changed without changing shape — it now
    // exists to stop the exit this same retirement causes from being reported a SECOND time, not to
    // suppress the only report there was.
    if (child.retiring || (code === 0 && child.queued === 0)) {
      this.dropIfStillOurs(child.dir, child.handle.pid);
      return;
    }

    const stderr = readTail(errPath(child.dir), 300);
    // Also to the journal, not only to the UI. A death reported into a browser tab that is closed
    // an hour later is a death nobody can attribute — which is how three of 2026-08-12's restarts
    // stayed unexplained while the process that saw them said nothing durable.
    console.log(
      `[loom] child ${short(sessionId)} died unexpectedly — exit ${code} · ${child.queued} turn(s) in flight` +
        ` · last turn ${child.lastCache}${stderr.length > 0 ? ` · stderr: ${stderr}` : ""}`,
    );
    this.dropIfStillOurs(child.dir, child.handle.pid);
    this.onEvent({
      sessionId,
      state: "error",
      detail: stderr.length > 0 ? stderr : `the session's claude process exited (${code})`,
      queued: 0,
      // A dead child answers nothing it was holding: the queue is gone, and so are its echoes. Better
      // an echo that disappears with the process than one that waits forever on a reply nobody owes.
      pending: [],
      step: null,
      stepMs: 0,
    });
  }

  /**
   * Is this child waiting on work it started? The impure edge of the background-work rule: reading
   * the transcript is the only way to know, and `hasUnfinishedBackgroundWork` is the judgement over
   * what was read.
   *
   * Re-read only when the file has GROWN — this runs on every eviction sweep and a long session's
   * transcript is megabytes. A transcript that exists but cannot be read counts as work in flight,
   * because the whole point is not to cut on ignorance; a transcript that is not there at all counts
   * as no work, since a child that has never written a turn has nothing running and treating absent
   * as busy would make it immortal.
   */
  private backgroundWork(sessionId: string, child: Child): boolean {
    const path = join(process.env["LOOM_PROJECTS_ROOT"] ?? PROJECTS_ROOT, escapeCwd(child.cwd), `${sessionId}.jsonl`);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return false; // no transcript at all — nothing has ever run here
    }
    if (size === child.bgSize) return child.bgAnswer;
    try {
      const rows: Array<Record<string, unknown>> = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          rows.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // A half-written trailing line is normal on a live transcript; the rest still counts.
        }
      }
      child.bgSize = size;
      child.bgAnswer = hasUnfinishedBackgroundWork(rows);
    } catch {
      child.bgSize = -1; // ask again next sweep rather than caching an unknown
      child.bgAnswer = true;
    }
    return child.bgAnswer;
  }

  private armIdle(sessionId: string, child: Child): void {
    if (child.idleTimer !== null) clearTimeout(child.idleTimer);
    child.idleTimer = setTimeout(() => {
      if (child.queued > 0) return;
      // A session waiting on an hour-long sweep is not idle. RE-ARM is the load-bearing word: this
      // timer has already fired, so deferring without arming a new one means nothing ever asks
      // again and the child becomes immortal.
      if (this.backgroundWork(sessionId, child)) {
        this.armIdle(sessionId, child);
        return;
      }
      this.retire(sessionId, "idle");
    }, idleDelay(child.cacheAt, Date.now()));
  }

  /**
   * Retire a cold, idle child once the cap is reached — never a busy one, and never one whose
   * prompt cache is still live. The choice itself is `evictionChoice`, pure and pinned.
   */
  private evictIfCrowded(): void {
    while (this.children.size >= MAX_LIVE) {
      const now = Date.now();
      const chosen = evictionChoice(
        [...this.children].map(([id, c]) => ({
          id,
          queued: c.queued,
          retiring: c.retiring,
          cacheAt: c.cacheAt,
          lastUsed: c.lastUsed,
          background: this.backgroundWork(id, c),
        })),
        now,
      );
      if (chosen === null) {
        // Nothing is safe to cut: everything is either working or still holding a live cache. Going
        // over the cap is the cheaper error. Said out loud, because the alternative is a memory
        // ceiling that quietly stops being one.
        console.log(
          `[loom] over the child cap (${this.children.size} live) — nothing idle with a cold cache to retire`,
        );
        return;
      }
      this.retire(chosen, "making room");
    }
  }

  /**
   * End a child on purpose, and clear its spool so nothing adopts it later.
   *
   * Retiring used to close stdin and let the CLI notice; since 2026-08-29 it cannot, because the
   * child holds its own stdin open and will never see EOF — that is exactly the property that makes
   * it survive a restart. So a deliberate end is a SIGNAL now. Every caller is either an idle child,
   * an evicted idle child, a respawn for new argv, or a dead pipe, so nothing is interrupted
   * mid-thought that was not already being dropped; the grace before SIGKILL is unchanged.
   *
   * The reason is LOGGED rather than dropped. It used to be an unused parameter, and the cost of
   * that showed up on 2026-08-12: three of the day's restarts could be seen in the token numbers
   * and could not be attributed to anything, because the one process that knew why never said so.
   */
  private retire(sessionId: string, why: string): void {
    const child = this.children.get(sessionId);
    if (child === undefined) return;
    child.retiring = true;
    this.children.delete(sessionId);
    if (child.idleTimer !== null) clearTimeout(child.idleTimer);
    const now = Date.now();
    console.log(
      `[loom] retire ${short(sessionId)} — ${why} · alive ${Math.round((now - child.bornAt) / 1000)}s` +
        ` · ${Math.round((now - child.cacheAt) / 1000)}s since its cache was written` +
        ` · last turn ${child.lastCache}`,
    );
    // A turn queued when the child is retired never lands — User's decision, 2026-08-24: it is
    // NOT resent, automatically or by a button, so this is the only notice he ever gets. `reap()`
    // never reports one for a retiring child (its `child.retiring` guard below is unconditional),
    // which is exactly why this used to report nothing at all: every one of the four call sites —
    // a model/thinking-level change, a dead pipe, eviction, `shutdown()` — retires through here.
    // An IDLE retire (queued === 0) says nothing: there was no turn to drop, and the client's
    // `state.job` is already correct from whatever event landed when the last turn actually ended.
    if (child.queued > 0) {
      this.onEvent({
        sessionId,
        state: "error",
        detail: `turn dropped — ${why}`,
        queued: 0,
        pending: [],
        step: null,
        stepMs: 0,
      });
    }
    closeQuietly(child.stdinFd);
    void this.hardStop(sessionId, child);
  }

  /** SIGTERM, then SIGKILL for the ones that ignore it and leak the day away. */
  private async hardStop(sessionId: string, child: Child): Promise<void> {
    child.handle.kill("SIGTERM");
    if (await settled(child.handle.exited, RETIRE_GRACE_MS)) {
      this.dropIfStillOurs(child.dir, child.handle.pid);
      return;
    }
    console.log(`[loom] ${short(sessionId)} outlived SIGTERM — SIGKILL`);
    child.handle.kill("SIGKILL");
    await settled(child.handle.exited, RETIRE_GRACE_MS);
    this.dropIfStillOurs(child.dir, child.handle.pid);
  }
}

/**
 * Write one newline-terminated frame into the child's stdin FIFO.
 *
 * `writeSync` can return short on a pipe, so the loop is the correctness, not a nicety: a message
 * carrying a pasted image is megabytes against a 64KB pipe buffer.
 */
function writeLine(fd: number, payload: string): void {
  const bytes = new TextEncoder().encode(`${payload}\n`);
  let written = 0;
  while (written < bytes.byteLength) {
    written += writeSync(fd, bytes, written, bytes.byteLength - written);
  }
}

/** The last `max` characters of a file, for a death report. Absent or unreadable reads as empty. */
function readTail(path: string, max: number): string {
  try {
    return readFileSync(path, "utf8").trim().slice(-max);
  } catch {
    return "";
  }
}

/**
 * The transcript store's directory-name escape — the same rule the real binary uses, checked
 * against `~/.claude/projects/` on this box. The test stub needs it to write where a real `claude`
 * would, and since 2026-09-01 `backgroundWork` needs it to find a live child's transcript.
 */
export function escapeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

/**
 * The cwd out of a child's spawn fingerprint (`model|effort|mode|cwd`). An adopted child has only
 * its meta, and the meta carries the spec and no other copy of where the child is running — so this
 * is how a restarted loom still knows where that session's transcript lives. Rejoined on `|`,
 * because a path may contain one and the cwd is the last field.
 */
export function cwdOfSpec(spec: string): string {
  return spec.split("|").slice(3).join("|");
}
