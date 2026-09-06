import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir, cpus } from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isLiveHolder } from "./pid-alive.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// A run owns a PORT, a fixture, a records tree, a state dir and an output dir — and shares none of
// them, or two sessions running the gate at once corrupt each other rather than queue. `LOOM_PINS=b
// bun run pins` moves all five together; unset is byte-for-byte the old single-run layout.
//
// A session WORKTREE (tools/session/session.sh new) needs none of that path slotting: its whole
// checkout is a separate directory, so the fixture, records, state and output dirs are already
// private. The one thing a directory cannot separate is the TCP port — so a worktree moves only
// the port, read from its `.session` marker. Slotting its paths as well would be redundant, and
// would break every run whose make-fixture predates LOOM_FIXTURE_AUTH.
const marker = (() => {
  try {
    return readFileSync(join(ROOT, "..", "..", ".session"), "utf8");
  } catch {
    return "";
  }
})();
const markerPort = Number(/^port=(\d+)$/m.exec(marker)?.[1]) || 0;

// Playwright's output — traces, screenshots, videos, error dumps — is regenerable and large: 92 MB
// across 27 `test-results-*` directories in the main tree, measured 2026-08-24, one `error-context.md`
// inside it 98,761 bytes. Written inside the repo it was git-ignored, which stops a commit and
// nothing else: every glob, grep and file search still walked it, and Resilio synced every byte to
// the other machine. So it goes OUTSIDE the checkout, keyed by worktree slug so two trees never
// share a directory, and `LOOM_OUT` overrides for anyone who wants it elsewhere.
const TREE = /^slug=(.+)$/m.exec(marker)?.[1]?.trim() || "main";
const OUT = process.env["LOOM_OUT"] || join(homedir(), ".cache", "loom-pins", TREE);
const SLOT = process.env["LOOM_PINS"] ?? "";
// Sum every character, not just the first: two slots starting with the same letter would otherwise
// land on the same port and rebuild each other's fixture — the failure this slotting exists for.
const hash = [...SLOT].reduce((n, c) => n + c.charCodeAt(0), 0);
// +100 off the worktree's dev port, which session.sh already keeps unique, so the pins never collide
// with the loom that worktree is serving nor with another worktree's pins.
const PORT_BASE = SLOT !== "" ? 4180 + ((hash % 40) + 1) : markerPort ? markerPort + 100 : 4180;

// Taking EVERY core is what leaves loom's own server fighting for one while its gate runs. Measured
// 2026-08-31 at cpus().length: load average 57 on 8 cores, and User could not use loom at all.
// That bought a cap of 4, and 4 was still too many: on 2026-09-01 memory, not cores, turned out to
// be the binding constraint. The 8-core machine has 31 GiB of RAM.
// ~14 GiB is spent before any work starts (media and home services 3.7 GiB, development
// and agent services 10.3 GiB). loom itself is allowed 4 GiB. That leaves roughly 8 GiB
// of real headroom. A headless Chromium instance under an active test measures 250 to 300 MB
// of PSS while idle, and considerably more with pages loaded. A Playwright worker is one
// browser plus its renderers. Six workers takes the box down, so the default is capped at 2.
// The env var stays the override, and verify.ts still forces 1 for the latency pin.
const WORKERS = Math.max(1, Number(process.env["LOOM_PIN_WORKERS"] ?? 2));

const isWorker = process.env["TEST_WORKER_INDEX"] !== undefined;
// TEST_WORKER_INDEX says WHICH worker process this is and keeps counting up: Playwright retires a
// worker after a failure and starts a fresh one, so on a suite with three failures the ninth and
// tenth worker appear even though only eight run at once. Slotting on it asked for `.state-w8` and
// `.state-w9`, which no webServer had created, and two more specs died on the missing storage state
// (measured 2026-08-30, 8 workers, 3 real failures + 2 caused by this). TEST_PARALLEL_INDEX is the
// SLOT rather than the process — always 0..workers-1, handed back when a worker is replaced — which
// is exactly what a port and a fixture directory want to be keyed on.
const parallelIndex = Number(process.env["TEST_PARALLEL_INDEX"] ?? 0);

const portFor = (i) => PORT_BASE + i;
const slotFor = (name, i) => `${name}${SLOT !== "" ? `-${SLOT}` : ""}-w${String(i)}`;

const MY = isWorker ? parallelIndex : 0;
const PORT = portFor(MY);
const slot = (name) => slotFor(name, MY);

// The slotting above only helps if a run REMEMBERS to slot, and a forgotten slot does not fail
// loud — it fails as a screenful of red in specs the session never touched, because the other run
// rebuilt the fixture underneath it. Cost measured 2026-08-08: five full suites read as regressions
// before the config was read. So a run takes a lock on the paths it owns and refuses to share them.
// Only the RUNNER takes it. Playwright re-imports this config inside every worker, and a worker
// finding its own parent's lock would fail the whole suite on the guard meant to protect it —
// caught by driving a stale lock through, which is the only reason it was found before shipping.
const LOCK = join(ROOT, "tests", `${slot("pins")}.lock`); // tests/ always exists; outputDir may not
const holder = isWorker
  ? 0
  : (() => {
      try {
        const pid = Number(readFileSync(LOCK, "utf8").trim());
        // `process.kill(pid, 0)` only asks "does this pid slot exist" — a ZOMBIE still occupies its
        // slot, so it answers yes for a runner that has been gone for minutes (item 59, proved
        // against a real zombie in verify-speed/pid-check.ts). `/proc/<pid>/stat`'s state field
        // tells the two apart; a stale or unreadable lock is treated as no holder either way.
        return isLiveHolder(pid) ? pid : 0;
      } catch {
        return 0;
      }
    })();
if (holder !== 0) {
  throw new Error(
    `another pin run (pid ${holder}) already owns ${SLOT === "" ? "the default slot" : `slot "${SLOT}"`} ` +
      `and its fixture, ports ${PORT_BASE}-${PORT_BASE + WORKERS - 1} and state dirs. Give this run its own: ` +
      `LOOM_PINS=<yourslot> bun run pins`,
  );
}
try {
  if (isWorker) throw new Error("worker"); // the runner owns the lock; a worker only reads the config
  writeFileSync(LOCK, String(process.pid));
  process.on("exit", () => {
    try {
      unlinkSync(LOCK);
    } catch {
      /* someone else's cleanup won the race — nothing to undo */
    }
  });
} catch {
  /* outputDir does not exist on a first run; the lock is a guard, never a gate on the suite */
}

// A run killed by SIGKILL — a shell `timeout`, a harness cap, a session closed mid-suite — never
// tears its webServer down, and the exec'd `bun server/main.ts` keeps the port. The next run then
// either aborts with "already used" or, worse, drives the ORPHAN: same port, same fixture tree, a
// stale bundle, and a screenful of failures in specs the session never touched (24 of them,
// 2026-08-10; friction loom-pins-orphan-4180, fourth recurrence). The lock above has already proved
// no LIVE runner owns this slot, so anything still holding the port is dead work — reap it, rather
// than leaving a human to run `ss` and `kill -9` between suites.
if (!isWorker) {
  for (let i = 0; i < WORKERS; i += 1) {
    const port = portFor(i);
    const listeners = spawnSync("ss", ["-lptnH", `sport = :${port}`], { encoding: "utf8" }).stdout ?? "";
    for (const pid of new Set([...listeners.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))) {
      // Only ever loom's own test server: matched on the command AND the port it was handed, so a
      // stray process of User's that happens to sit on this port is left alone and still fails loud.
      let cmdline = "";
      let env = "";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        env = readFileSync(`/proc/${pid}/environ`, "utf8");
      } catch {
        continue; // not Linux, or the process is already gone
      }
      if (!cmdline.includes("server/main.ts")) continue;
      if (!env.includes(`LOOM_PORT=${port}\0`) || !env.includes("NODE_ENV=test\0")) continue;
      console.log(`[pins] reaping orphaned test server pid ${pid} on port ${port}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* it exited between the listing and the kill — the outcome we wanted anyway */
      }
    }
  }
}

// A child now OUTLIVES the loom that spawned it (SPEC 255) — that is the feature. The cost here is
// that Playwright tears the server down with a SIGTERM, which is a detach, so a run leaves its
// stubs alive and the next run over the same slot would ADOPT them: the previous suite's child
// answering this suite's fixture session. Sweep the slot's spool before the server boots. The stub
// also exits on its own after ten idle minutes, but that is the last resort, not this.
const SPOOL = join(OUT, slot("test-results"), "spool");
if (!isWorker) {
  for (let i = 0; i < WORKERS; i += 1) {
    const workerSpool = join(OUT, slotFor("test-results", i), "spool");
    for (const port of existsSync(workerSpool) ? readdirSync(workerSpool) : []) {
      for (const session of readdirSync(join(workerSpool, port))) {
        try {
          const { pid } = JSON.parse(readFileSync(join(workerSpool, port, session, "meta.json"), "utf8"));
          if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("stub-claude.ts")) process.kill(pid, "SIGKILL");
        } catch {
          /* gone, unreadable, or not our stub — the rm below is the point either way */
        }
      }
    }
    rmSync(workerSpool, { recursive: true, force: true });
  }
}

// NixOS cannot run Playwright's downloaded browser (no libglib in the closure), so on the box the
// pins drive the system chromium, exactly as tools/hub does. On the Mac the path is absent and the
// bundled browser is used, which is why this is a conditional and not a hard path.
const CHROMIUM = process.env["PIN_CHROMIUM"] || "/run/current-system/sw/bin/chromium";
const launch = existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {};

// The box exports HTTP_PROXY=127.0.0.1:11808, and Playwright's webServer readiness probe honours it —
// so the probe asks the proxy for localhost:4180, gets nothing, and times out after 60s against a
// server that is already up. Exempt loopback in this process before the probe runs.
process.env["NO_PROXY"] = "localhost,127.0.0.1,::1";
process.env["no_proxy"] = "localhost,127.0.0.1,::1";

if (!isWorker) {
  for (let i = 0; i < WORKERS; i += 1) {
    const dir = join(OUT, slotFor("test-results", i));
    mkdirSync(dir, { recursive: true });
    try {
      unlinkSync(join(dir, "stub-hold"));
    } catch {
      /* not there is the normal case */
    }
    writeFileSync(
      join(dir, "quota.json"),
      JSON.stringify({
        limits: [
          {
            kind: "session",
            percent: 23,
            severity: "normal",
            resets_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          },
          {
            kind: "weekly_all",
            percent: 41,
            severity: "normal",
            resets_at: new Date(Date.now() + 40 * 60 * 60 * 1000).toISOString(),
          },
        ],
      }),
    );
  }
}

// Two specs append rows to the fixture from the RUNNER process, so they need the same slotted path
// the server was given — otherwise a slotted run writes into the unslotted fixture and the live-tail
// assertions wait 40s for a row that landed in another run's world (2026-08-06).
// The spec that holds a turn open needs the same path the server gave the stub, and a run must not
// start with a stale release file lying around from the last one.
process.env["LOOM_STUB_HOLD"] = join(OUT, slot("test-results"), "stub-hold");
// The output dir now lives outside the checkout, so nothing has made it by the time a spec writes
// the release file into it — Playwright only creates it when it has an artifact to put there.
mkdirSync(join(OUT, slot("test-results")), { recursive: true });
try {
  unlinkSync(process.env["LOOM_STUB_HOLD"]);
} catch {
  /* not there is the normal case */
}
process.env["LOOM_FIXTURE_OUT"] = join(ROOT, "tests", "fixture", slot("projects"));
// journey16 mints records and deletes them again in an afterAll. It used to rebuild that path from
// LOOM_PINS by hand, which stopped being the real path the moment the slot grew a worker suffix —
// so the cleanup removed nothing and journey4's exact tree count read 8 instead of 6, on whichever
// worker happened to run the two in that order (2026-08-30). The runner reads the path rather than
// deriving it.
process.env["LOOM_RECORD_ROOTS"] = join(ROOT, "tests", "fixture", slot(".records"));
// The bar spec appends to the meter archive from the RUNNER process, for the same reason.
process.env["LOOM_BAR_ARCHIVE"] = join(ROOT, "tests", "fixture", slot("transcripts"));
// The quota the badge draws. Left alone, `server/usage.ts` would call the real endpoint and the
// pin would assert against whatever User's account happens to read this afternoon — and would
// fail with no network at all. The spec REWRITES this file to drive the severity and stale states,
// which is why the poll gap is dropped to 300ms alongside it (usage-bar, 2026-08-26).
process.env["LOOM_QUOTA_STUB"] = join(OUT, slot("test-results"), "quota.json");
// The stub must exist BEFORE the server boots — `readQuota` only ever reports what this file
// holds, so a first paint racing an empty/missing stub shows nothing and the spec has to wait it
// out. Seeded NOW-relative: a `session` window at 23%/normal resetting ~4h out, a `weekly_all`
// window at 41% resetting ~40h out. The spec rewrites this same file to drive severity and the
// stale path; this is only the starting point.
writeFileSync(
  process.env["LOOM_QUOTA_STUB"],
  JSON.stringify({
    limits: [
      {
        kind: "session",
        percent: 23,
        severity: "normal",
        resets_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      },
      {
        kind: "weekly_all",
        percent: 41,
        severity: "normal",
        resets_at: new Date(Date.now() + 40 * 60 * 60 * 1000).toISOString(),
      },
    ],
  }),
);

// Headless standalone Playwright in its own process — never the interactive playwright-MCP session,
// where the ledgered lock/orphan failures live.
export default defineConfig({
  testDir: "./drive/specs",
  // 45s until 2026-08-23. A windowed transcript (SPEC 228) means a spec that wants a turn deep in
  // the session has to SCROLL to it, the way a reader would, and a sweep of a long fixture is
  // seconds — enough that the longest journeys stopped finishing rather than started failing.
  timeout: 90_000,
  fullyParallel: true,
  workers: WORKERS,
  reporter: [["list"]],
  outputDir: join(OUT, slot("test-results")),
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    // The fixture step writes this file with the loom_token cookie — every data route requires it
    // (SPEC invariant 7). The auth spec overrides with an empty state to drive the login flow.
    storageState: join(ROOT, "tests", slot(".state"), "storage-state.json"),
    launchOptions: {
      ...launch,
      // Unsetting the *_PROXY env vars is not enough — chromium also reads a system proxy config,
      // and only the launch flag wins (hub, verified 2026-08-01).
      // The first two are the proxy flags. The rest are a memory ceiling on the browser TREE:
      // measured 2026-08-31, eight unconstrained chromiums forked 130 processes holding 15.2 GB,
      // which is where the machine's memory went. Site isolation forks a renderer per origin frame
      // and the pins drive one origin, so it buys nothing here and costs the most.
      args: [
        "--no-proxy-server",
        "--proxy-bypass-list=<-loopback>",
        "--disable-dev-shm-usage",
        "--disable-features=site-per-process",
        "--renderer-process-limit=2",
        "--js-flags=--max-old-space-size=512",
        "--disable-gpu",
      ],
    },
    trace: "retain-on-failure",
  },
  webServer: Array.from({ length: WORKERS }, (_, i) => ({
    // The fixture is rebuilt on every run, so the evidence is always fresh.
    //
    // `exec` is load-bearing: Playwright kills the SHELL it spawned, and a child that is not exec'd
    // outlives it. Every run then left a server holding 4180, so the next one died with "already
    // used" — or ran against the previous run's state dir and produced a screenful of failures that
    // had nothing to do with the change under test (friction loom-pins-orphan-4180, 2026-08-06).
    command: "bun tests/fixture/make-fixture.ts && exec bun server/main.ts",
    cwd: ROOT,
    url: `http://localhost:${portFor(i)}`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    env: {
      LOOM_PORT: String(portFor(i)),
      // Every path a run writes to carries the slot, so a second session's run cannot rewrite the
      // fixture this one is mid-way through reading.
      LOOM_FIXTURE_OUT: join(ROOT, "tests", "fixture", slotFor("projects", i)),
      LOOM_PROJECTS_ROOT: join(ROOT, "tests", "fixture", slotFor("projects", i)),
      LOOM_AGY_PROJECTS_ROOT: join(ROOT, "tests", "fixture", slotFor("agy-projects", i)),
      // The spouse core's watched dir falls back into the real vault — seal it into the run.
      LOOM_SPOUSE_DIR: join(ROOT, "tests", "fixture", slotFor("spouse-dir", i)),
      // The rest of that core, for the same reason: where its sessions run and what it is called are
      // the install's business, and both fall back into the real vault (2026-09-05).
      LOOM_SPOUSE_CORE: join(ROOT, "tests", "fixture", slotFor("spouse-core", i)),
      LOOM_SPOUSE_LABEL: "Spouse",
      LOOM_FIXTURE_AUTH: join(ROOT, "tests", slotFor(".state", i)),
      LOOM_FIXTURE_RECORDS: join(ROOT, "tests", "fixture", slotFor(".records", i)),
      LOOM_STATE: join(OUT, slotFor("test-results", i), "state"),
      // Session→project links. It falls back THROUGH LOOM_STATE to a path in the real vault, so the
      // fallback escapes even though LOOM_STATE right above is sealed — name it too.
      LOOM_LINKS: join(OUT, slotFor("test-results", i), "state"),
      // Where this run's children live (SPEC 255). Slotted like everything else, and swept above.
      LOOM_SPOOL: join(OUT, slotFor("test-results", i), "spool"),
      LOOM_POLL_MS: "200",
      // The block meter counts EVERY session on the machine, so left alone it would read the real
      // archive and the pin would assert against whatever User is running. Its own tree, slotted
      // like the rest, and rebuilt NOW-relative by make-fixture so an open block exists.
      LOOM_BAR_ARCHIVE: join(ROOT, "tests", "fixture", slotFor("transcripts", i)),
      // See the note beside LOOM_QUOTA_STUB above: a stubbed quota, repolled fast enough that a
      // spec can step through severities without waiting a real minute per step.
      LOOM_QUOTA_STUB: join(OUT, slotFor("test-results", i), "quota.json"),
      LOOM_QUOTA_POLL_MS: "300",
      // The pane's readable root under test is loom itself: the fixture points a chip at
      // ARCHITECTURE.md, and everything outside must come back 403 from the same guard.
      LOOM_ROOTS: ROOT,
      // The input spec drives the write path against a stub binary — hermetic, free, and faithful
      // to the spike-pinned contract of the real one (DECISIONS.md 2026-08-05).
      LOOM_CLAUDE_BIN: join(ROOT, "tests", "stub-claude.ts"),
      LOOM_PERMIT_TIMEOUT_MS: "30000",
      LOOM_TOKEN: "loom-test-token",
      // The file a spec touches to release a held stub turn (loom item 58). Slotted with everything
      // else so two runs cannot release each other's turns.
      LOOM_STUB_HOLD: join(OUT, slotFor("test-results", i), "stub-hold"),
      LOOM_RECORD_ROOTS: join(ROOT, "tests", "fixture", slotFor(".records", i)),
      // The vault the CORES describe (server/cores.ts). Pointed at a fixture vault beside the
      // records rather than the real `~/resilio/docs`, so a fixture record is never "in the vault"
      // and keeps its own directory as its child's cwd — see the note in make-fixture.ts.
      LOOM_CORE_VAULT: join(ROOT, "tests", "fixture", slotFor("vault", i)),
      // What this device has read (server/seen.ts). Left unset it falls back to
      // `<LOOM_CORE_VAULT>/Projects/Personal Claude/tools/loom/seen` — which, before
      // LOOM_CORE_VAULT existed, was User's REAL seen file: every pin run read his watermark and
      // wrote fixture session ids into it, four workers and his own loom appending to one file.
      // That is how journey4's attention case became permanently red in the full suite and green
      // alone (2026-09-01): a spec that advances a frozen clock marks the fixture session read at a
      // FUTURE timestamp, the write persists, and from then on no reply can ever beat the floor.
      // Slotted like every other path, so a run starts with nothing read and cannot poison the next.
      LOOM_SEEN_DIR: join(OUT, slotFor("test-results", i), "seen"),
      // The ask rules that raise a permit card (server/main.ts). Its own comment already says a
      // test depending on the real settings file changes meaning when User edits it — the
      // variable was simply never set here, so every pin server read `~/.claude/settings.json` at
      // boot. Pointed at a slotted path that does not exist; `readAskRules` answers [] for a file
      // it cannot read, which is the "no rules" the pins want (audited 2026-09-01).
      LOOM_ASK_SETTINGS: join(OUT, slotFor("test-results", i), "ask-settings.json"),
      // Sealed for the same reason, though nothing reads it today: `usage.ts` takes the
      // LOOM_QUOTA_STUB branch first and never reaches the cache path. That makes this a dormant
      // leak rather than a live one, and dormant is only one edit away from live.
      LOOM_QUOTA_CACHE: join(OUT, slotFor("test-results", i), "quota-cache.json"),
      // Where a Gemini session's shadow transcript is written (SPEC 280). Its fallback is
      // `~/.loom/agy/projects`, so an unsealed pin run would append fixture turns to the real one —
      // the same leak `LOOM_SEEN_DIR` had, and `sealed.test.ts` is what caught it here before any
      // pin ran against a live agy session.
      LOOM_AGY_PROJECTS_ROOT: join(OUT, slotFor("test-results", i), "agy-projects"),
      NODE_ENV: "test",
    },
  })),
});
