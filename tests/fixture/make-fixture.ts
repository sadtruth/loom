/**
 * Build the journey fixture: a REAL transcript plus a few appended rows in the real format.
 *
 * Real, because VERIFY.md forbids proving the UI against a synthetic three-line file — the shapes
 * that break a viewer (thinking blocks, orphan tool results, 20k-char Bash output, a path with a
 * space in it) only exist in real data. Appended, because the journey has to assert on specific
 * chips and rich blocks, and no real transcript is guaranteed to contain them.
 */

import { mkdir, rm, readdir, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { escapeCwd } from "../../server/input.ts";

const HERE = import.meta.dir;
/**
 * Overridable so two working sessions can run the pins AT THE SAME TIME. The fixture, the state dir
 * and the port are one run's whole world: share any of them and the second run either dies on
 * "4180 is already used" or — worse — silently reads the first run's half-rewritten records and
 * fails somewhere unrelated to the change under test (friction `loom-pins-orphan-4180`, hit again
 * 2026-08-06 with two subprojects of projects-model open at once).
 */
const OUT = Bun.env["LOOM_FIXTURE_OUT"] ?? join(HERE, "projects");
/** A file that really exists and really is inside loom's readable roots, for the file pane. */
const REAL_DIR = join(HERE, "..", "..");
const REAL_FILE = join(REAL_DIR, "ARCHITECTURE.md");
const PROJECT_KEY = "-fixture-project";
const SESSION_ID = "00000000-fixture-0000-000000000001";
const MAX_BYTES = 2_000_000;

/**
 * Strings whose presence in a base transcript breaks the journey from the inside: loom-development
 * sessions discuss the tests' own markers and fixtures, so on a machine where loom is being built,
 * the largest recent transcript is often one that already CONTAINS "Пришло позже" (the live-append
 * assertion counted 4 before appending anything) and grid blocks pointing at dead paths (a 400 the
 * journey rightly counts as a page error). Self-contamination, found on the box 2026-08-05.
 */
const POISON = ["Пришло позже", "```grid"];

/**
 * Content filtering was not enough, because the contamination is structural rather than textual: a
 * session whose cwd is inside loom talks about loom's own files, so its paths become chips that the
 * journey clicks and the guard refuses. Excluding those directories outright is the fix — a
 * loom-development transcript can never be the base, whatever it happens to contain.
 *
 * Found again 2026-08-06: the base had become session `0c60c66f`, run from `tools/loom`, and the
 * journey failed on a 400 from a chip in text we had written that morning.
 */
const SELF_DIRS = ["tools-loom", "Personal-Claude-tools"];

/** Largest real NON-POISONED transcript under the size cap: variety without self-reference. */
import { barRow } from "./bar-row.mjs";

async function pickRealTranscript(): Promise<string | null> {
  const root = join(homedir(), ".claude", "projects");
  const candidates: Array<{ path: string; size: number }> = [];
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    if (SELF_DIRS.some((marker) => dir.includes(marker))) continue;
    let files: string[];
    try {
      files = (await readdir(join(root, dir))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(root, dir, file);
      try {
        const info = await stat(path);
        if (info.size > MAX_BYTES) continue;
        candidates.push({ path, size: info.size });
      } catch {
        continue;
      }
    }
  }
  // Size, then path: two transcripts of equal size must not swap places between runs.
  candidates.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  for (const candidate of candidates) {
    try {
      const text = await Bun.file(candidate.path).text();
      if (POISON.some((marker) => text.includes(marker))) continue;
      return candidate.path;
    } catch {
      continue;
    }
  }
  return null;
}

const SYNTHETIC_BASE = [
  {
    type: "user",
    uuid: "11111111-0000-0000-0000-000000000001",
    parentUuid: null,
    timestamp: "2026-07-31T09:00:00.000Z",
    sessionId: SESSION_ID,
    cwd: "/Users/user/docs/Projects/Personal Claude",
    gitBranch: "master",
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text: "fixture base turn" }] },
  },
  {
    type: "assistant",
    uuid: "11111111-0000-0000-0000-000000000002",
    parentUuid: "11111111-0000-0000-0000-000000000001",
    timestamp: "2026-07-31T09:00:05.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "fixture thinking block" },
        { type: "text", text: "**Verdict line.** A synthetic base turn." },
      ],
    },
  },
];

/** A 1×1 PNG. Real bytes, so the grid block exercises /api/file instead of 404ing. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A 2400×1400 PNG (2.5 kB: two flat quadrants and a black square in the middle). The viewer pins
 * need an image BIGGER THAN THE WINDOW at both sizes they drive — against anything that already
 * fits, the viewer opens it centred and the clamp, not the anchor, decides where it sits, so a
 * zoom that ignored the pointer entirely would pass every assertion (SPEC §117/§118).
 */
const PNG_BIG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAACWAAAAV4AgMAAABZBg5/AAAADFBMVEX6+vi4hjs7bswUFBRkV7puAAAJpUlEQVR42u3VQRGAMAxFQcJgAT+YSPWgpy4wgR2w0AO9kF0BzPB5tNEXRt2nDUatJkBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlgIywQIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLYZkAYSEsaote+/1z2pOvw4kFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEshGUChIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYSEsEBbCQlggLISFsEBYCIuaNhNMsmftsFrtz//4A1yFCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWwjIBwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsBAWCAthISz4WJhgXJrAiYWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsJCWCZAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYCMsECAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLIQFwkJYCAuEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwkJYICyEhbBAWAgLYYGwEBbCAmEhLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWCAshIWwQFgIC2GBsBAWwgJhISyEBcJCWAgLhIWwEBYIC2EhLBAWwuKHXjeTEQbfCRKLAAAAAElFTkSuQmCC";
const PNG_BIG = Buffer.from(PNG_BIG_BASE64, "base64");

/** The rows the journey asserts on. Paths deliberately carry a space and Cyrillic. */
const appendedRows = (dir: string): unknown[] => [
  {
    type: "user",
    uuid: "22222222-0000-0000-0000-000000000001",
    parentUuid: null,
    timestamp: "2026-07-31T15:00:00.000Z",
    sessionId: SESSION_ID,
    cwd: "/Users/user/docs/Projects/Personal Claude",
    gitBranch: "master",
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "text", text: "check the links and the blocks please" }],
    },
  },
  {
    type: "assistant",
    uuid: "22222222-0000-0000-0000-000000000002",
    parentUuid: "22222222-0000-0000-0000-000000000001",
    timestamp: "2026-07-31T15:00:10.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Deciding which paths to name." },
        {
          type: "text",
          text: [
            "**Chips, three flavours.** A plain absolute path with a space:",
            "/Users/user/docs/Projects/Personal Claude/tools/loom/SPEC.md",
            "",
            "A Cyrillic one: /Users/user/docs/Заметки/важный файл.md — and a relative code span",
            "`tools/loom/ARCHITECTURE.md` that must resolve against cwd.",
            "",
            "```table",
            "pane\trole",
            "rail\tindex",
            "drawer\tartifacts",
            "```",
            "",
            "```grid",
            `${dir}/shot-a.png | first`,
            `${dir}/shot-b.png | second`,
            "```",
          ].join("\n"),
        },
        {
          type: "tool_use",
          id: "toolu_fixture_read_1",
          name: "Read",
          input: { file_path: "/Users/user/docs/Projects/Personal Claude/tools/loom/SPEC.md" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "22222222-0000-0000-0000-000000000003",
    parentUuid: "22222222-0000-0000-0000-000000000002",
    timestamp: "2026-07-31T15:00:12.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_fixture_read_1", content: "SPEC contents…", is_error: false },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "22222222-0000-0000-0000-000000000004",
    parentUuid: "22222222-0000-0000-0000-000000000003",
    timestamp: "2026-07-31T15:00:20.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_fixture_write_1",
          name: "Write",
          input: { file_path: "/Users/user/docs/Projects/Personal Claude/tools/loom/FIXTURE.md", content: "x" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "22222222-0000-0000-0000-000000000005",
    parentUuid: "22222222-0000-0000-0000-000000000004",
    timestamp: "2026-07-31T15:00:21.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_fixture_write_1", content: "written", is_error: false }],
    },
  },
  // A PASTED image, the third place loom renders one full size (SPEC §117). It carries the same
  // 2400×1400 bytes as the grid's first tile, so the viewer pins can drive either path and expect the
  // same geometry.
  {
    type: "user",
    uuid: "22222222-0000-0000-0000-00000000000a",
    parentUuid: "22222222-0000-0000-0000-000000000005",
    timestamp: "2026-07-31T15:00:30.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "user",
      content: [
        // The path is named in prose as well, so it renders a chip — which is how the viewer pin
        // reaches the THIRD render site, the file pane, without a second fixture.
        { type: "text", text: `here is the screenshot, also at ${dir}/shot-a.png` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BIG_BASE64 } },
      ],
    },
  },
  // A run of tool calls long enough to FOLD, one of which FAILS — the folding rule and its one
  // exception in the same turn. Plus a chip pointing at a file that really exists inside loom's
  // readable roots, so the file pane can be driven end to end against real bytes.
  {
    type: "user",
    uuid: "22222222-0000-0000-0000-000000000006",
    parentUuid: "22222222-0000-0000-0000-000000000005",
    timestamp: "2026-07-31T15:01:00.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text: "now do a bunch of steps" }] },
  },
  {
    type: "assistant",
    uuid: "22222222-0000-0000-0000-000000000007",
    parentUuid: "22222222-0000-0000-0000-000000000006",
    timestamp: "2026-07-31T15:01:05.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Many small steps in a row." },
        { type: "tool_use", id: "toolu_fx_run_1", name: "Bash", input: { command: `cd "${REAL_DIR}" && grep -rn loom client/` } },
        { type: "thinking", thinking: "Another one." },
        { type: "tool_use", id: "toolu_fx_run_2", name: "Bash", input: { command: `cd "${REAL_DIR}" && bun run typecheck` } },
        { type: "tool_use", id: "toolu_fx_run_3", name: "Read", input: { file_path: REAL_FILE } },
        { type: "tool_use", id: "toolu_fx_run_4", name: "Bash", input: { command: `cd "${REAL_DIR}" && git status --short` } },
        { type: "tool_use", id: "toolu_fx_fail", name: "Bash", input: { command: `cd "${REAL_DIR}" && exit 1` } },
        { type: "text", text: `**Steps done.** The real file is ${REAL_FILE} — open it here.` },
      ],
    },
  },
  {
    type: "user",
    uuid: "22222222-0000-0000-0000-000000000008",
    parentUuid: "22222222-0000-0000-0000-000000000007",
    timestamp: "2026-07-31T15:01:06.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_fx_run_1", content: "client/app.ts:1", is_error: false },
        { type: "tool_result", tool_use_id: "toolu_fx_run_2", content: "ok", is_error: false },
        { type: "tool_result", tool_use_id: "toolu_fx_run_3", content: "# ARCHITECTURE", is_error: false },
        { type: "tool_result", tool_use_id: "toolu_fx_run_4", content: "clean", is_error: false },
        { type: "tool_result", tool_use_id: "toolu_fx_fail", content: "exit status 1", is_error: true },
      ],
    },
  },
  // ── turns that CARRY AN ARTIFACT, which is what the gutter marks (SPEC 192) ──────────────────
  //
  // Since 2026-08-20 a point is a build plan or a framed prototype and nothing else, so the gutter
  // pins need a session with several of them: one to count against the turns that carry none, and
  // enough of them close together for the spreading rule to have anything to spread. Five frames
  // and one plan, in six consecutive short turns near the end of a long transcript — consecutive on
  // purpose, because that is what puts their proportional places on the same pixel of the rail.
  ...[0, 1, 2, 3, 4].map((n) => [
    {
      type: "user",
      uuid: `22222222-0000-0000-0000-0000000000${(0xa1 + n * 2).toString(16)}`,
      parentUuid: null,
      timestamp: `2026-07-31T15:0${String(2 + n)}:00.000Z`,
      sessionId: SESSION_ID,
      cwd: "/Users/user/docs/Projects/Personal Claude",
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: `show me mockup ${String(n)}` }] },
    },
    {
      type: "assistant",
      uuid: `22222222-0000-0000-0000-0000000000${(0xa2 + n * 2).toString(16)}`,
      parentUuid: `22222222-0000-0000-0000-0000000000${(0xa1 + n * 2).toString(16)}`,
      timestamp: `2026-07-31T15:0${String(2 + n)}:05.000Z`,
      sessionId: SESSION_ID,
      isSidechain: false,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Frame ${String(n)}:\n\n\`\`\`iframe\n${dir}/gutter-frame.html | 120\n\`\`\`` }],
        stop_reason: "end_turn",
      },
    },
  ]).flat(),
  {
    type: "user",
    uuid: "22222222-0000-0000-0000-0000000000b1",
    parentUuid: null,
    timestamp: "2026-07-31T15:07:00.000Z",
    sessionId: SESSION_ID,
    cwd: "/Users/user/docs/Projects/Personal Claude",
    gitBranch: "master",
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text: "and the plan" }] },
  },
  {
    type: "assistant",
    uuid: "22222222-0000-0000-0000-0000000000b2",
    parentUuid: "22222222-0000-0000-0000-0000000000b1",
    timestamp: "2026-07-31T15:07:05.000Z",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Here:\n\n\`\`\`plan\n${dir}/gutter-plan.md\n\`\`\`` }],
      stop_reason: "end_turn",
    },
  },
  { type: "ai-title", aiTitle: "Fixture — консоль", sessionId: SESSION_ID },
];

/**
 * The block meter's own archive (SPEC §Bar), written NOW-relative so an open block exists.
 * A SEPARATE tree from the fixture project: the meter counts every session on the machine, so
 * pointing it at the real `~/.claude/projects` would make the pin assert against whatever User
 * happened to be running.
 */
async function writeBarArchive(): Promise<void> {
  const out = Bun.env["LOOM_BAR_ARCHIVE"];
  if (out === undefined || out.length === 0) return;
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "bar-project"), { recursive: true });
  const now = Date.now();
  let rows = "";
  // 200 calls at the measured median shape — 145k of context, 430 tokens of output — spread over
  // the last hour. That is ~1.88M weighted units, ~21% of the block: visibly non-zero, and far
  // enough from the 70% and 90% thresholds that the spec can drive it across both.
  for (let i = 0; i < 200; i++) rows += barRow(now - (200 - i) * 18_000, `fix-${String(i)}`, 145_000, 430);
  await Bun.write(join(out, "bar-project", "block.jsonl"), rows);
  console.log(`[fixture] wrote bar archive: 200 calls -> ${out}`);
}

async function main(): Promise<void> {
  await writeBarArchive();
  const dir = join(OUT, PROJECT_KEY);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // Pins persist across runs, so a stale pin would make the journey's pin assertions pass without
  // the button working. Clear the run's state dir with the fixture.
  const state = Bun.env["LOOM_STATE"];
  if (state !== undefined && state.length > 0) await rm(state, { recursive: true, force: true });

  const real = await pickRealTranscript();
  let base: string;
  if (real === null) {
    console.warn("[fixture] no real transcript store found — falling back to synthetic base");
    base = SYNTHETIC_BASE.map((r) => JSON.stringify(r)).join("\n") + "\n";
  } else {
    base = await Bun.file(real).text();
    if (!base.endsWith("\n")) base += "\n";
    console.log(`[fixture] base = ${real} (${base.length} chars)`);
  }

  // Two sizes on purpose: one bigger than the phone window (so the viewer has something to zoom and
  // pan) and one 1×1 (the "never upscale a small image" branch of `fitFrame`).
  await Bun.write(join(dir, "shot-a.png"), PNG_BIG);
  await Bun.write(join(dir, "shot-b.png"), PNG_1X1);

  // What the artifact turns at the end of `appendedRows` point at — a frame short enough that five
  // of them stay close together in the scroller, and a plan with the fields the parser requires.
  await Bun.write(
    join(dir, "gutter-frame.html"),
    '<!doctype html><meta charset="utf-8"><body style="margin:0;font:12px sans-serif">a fixture frame</body>\n',
  );
  await Bun.write(
    join(dir, "gutter-plan.md"),
    [
      "---",
      "id: 2026-08-20 · gutter fixture",
      "records: [loom-fixture-parent/project.md]",
      "size: S",
      "git: worktree fixture, off master",
      "work: [next 1]",
      "estimate: 1h",
      "---",
      "",
      "# A plan the gutter can mark",
      "",
      "## Log",
      "",
      "10:00 · written by the fixture",
      "",
    ].join("\n"),
  );

  const text = base + appendedRows(dir).map((r) => JSON.stringify(r)).join("\n") + "\n";
  const target = join(dir, `${SESSION_ID}.jsonl`);
  await Bun.write(target, text);
  console.log(`[fixture] wrote ${target}`);

  // ── a dedicated session for drafts (journey41) ──────────────────────
  // Every spec that types into composer writes to <stateDir>/drafts/<key>.json and broadcasts over
  // WebSocket. A dedicated fixture session isolates journey41 from any other spec typing in the suite.
  const draftsSession = "00000000-fixture-0000-000000000041";
  const draftsRows = [
    {
      type: "user",
      uuid: "41414141-0000-0000-0000-000000000001",
      parentUuid: null,
      timestamp: "2026-08-05T08:00:00.000Z",
      sessionId: draftsSession,
      cwd: REAL_DIR,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "drafts fixture opening turn" }] },
    },
    {
      type: "assistant",
      uuid: "41414141-0000-0000-0000-000000000002",
      parentUuid: "41414141-0000-0000-0000-000000000001",
      timestamp: "2026-08-05T08:00:05.000Z",
      sessionId: draftsSession,
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "**Ready.** Send something." }] },
    },
  ];
  const draftsTarget = join(dir, `${draftsSession}.jsonl`);
  await Bun.write(draftsTarget, draftsRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const older = new Date("2026-01-01T00:00:00Z");
  await utimes(draftsTarget, older, older);
  console.log(`[fixture] wrote ${draftsTarget}`);

  // ── the input-path fixture project ────────────────────────────────
  // Its cwd is the loom root itself — a directory that EXISTS on every machine — because the
  // Runner spawns the (stub) binary with cwd = the project's real cwd, and the stub then derives
  // its transcript path from that cwd with the same escapeCwd the fixture key uses. Consistency
  // by construction, not by matching the real CLI's escaping.
  const inputCwd = join(HERE, "..", "..");
  const inputDir = join(OUT, escapeCwd(inputCwd));
  const inputSession = "00000000-fixture-0000-000000000002";
  await mkdir(inputDir, { recursive: true });
  const inputRows = [
    {
      type: "user",
      uuid: "33333333-0000-0000-0000-000000000001",
      parentUuid: null,
      timestamp: "2026-08-05T08:00:00.000Z",
      sessionId: inputSession,
      cwd: inputCwd,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "input fixture opening turn" }] },
    },
    {
      type: "assistant",
      uuid: "33333333-0000-0000-0000-000000000002",
      parentUuid: "33333333-0000-0000-0000-000000000001",
      timestamp: "2026-08-05T08:00:05.000Z",
      sessionId: inputSession,
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "**Ready.** Send something." }] },
    },
  ];
  const inputTarget = join(inputDir, `${inputSession}.jsonl`);
  await Bun.write(inputTarget, inputRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Backdated so the journey's bare `goto("/")` still lands on ITS project — boot opens the
  // most-recently-active one, and this file would otherwise always be the newest write.
  await utimes(inputTarget, older, older);
  console.log(`[fixture] wrote ${inputTarget}`);

  // ── a TALL input-capable project, for the scroll pins ─────────────
  // journey12-scroll needs two things at once: a session it can SEND to (so a real turn runs and
  // the page grows under the reader), and one taller than the pane (so "travel left below the
  // reader" can be nonzero at all — the first draft of that pin drove the two-message input fixture
  // above and therefore could not fail). Its own project rather than 40 rows appended to that one:
  // growing a shared fixture at runtime moved journey2-input's queue assertions, and restoring the
  // file afterwards was worse — a shrinking file under a live tailer left a pending ghost that
  // never pruned (2026-08-08). cwd is `tests/`, a directory that exists, because the Runner spawns
  // the stub there and the stub derives its transcript path from it.
  const scrollCwd = join(HERE, "..");
  const scrollDir = join(OUT, escapeCwd(scrollCwd));
  const scrollSession = "00000000-fixture-0000-000000000004";
  await mkdir(scrollDir, { recursive: true });
  const scrollRows: unknown[] = [
    {
      type: "user",
      uuid: "44444444-0000-0000-0000-000000000001",
      parentUuid: null,
      timestamp: "2026-08-05T09:00:00.000Z",
      sessionId: scrollSession,
      cwd: scrollCwd,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "scroll fixture opening turn" }] },
    },
  ];
  for (let i = 0; i < 40; i += 1) {
    scrollRows.push({
      type: "assistant",
      uuid: `44444444-0000-0000-0000-${String(i + 2).padStart(12, "0")}`,
      parentUuid: null,
      timestamp: "2026-08-05T09:00:01.000Z",
      sessionId: scrollSession,
      isSidechain: false,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `scroll fixture line ${i} — height, so there is a bottom to be short of` }],
      },
    });
  }
  const scrollTarget = join(scrollDir, `${scrollSession}.jsonl`);
  await Bun.write(scrollTarget, scrollRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Backdated for the same reason as the input fixture: a bare `goto("/")` must not land here.
  await utimes(scrollTarget, older, older);
  console.log(`[fixture] wrote ${scrollTarget}`);

  // ── a HUGE session, for the windowed transcript (SPEC 228) ────────
  //
  // 2,600 turns, which is more than a real long session and far more than anything loom had ever
  // been driven against: the claim under test is that the cost of a session stops growing with its
  // length, and a claim about "even huge ones" cannot be checked on 180 turns. Its own project for
  // the same reason the scroll fixture has one — it must not move any other spec's row counts, and
  // a `goto("/")` must never land here.
  //
  // Two artifacts, placed on purpose. A framed prototype near the END, which is mounted when the
  // session opens, so scrolling away from it and back is what proves a turn that stays modelled is
  // not rebuilt when it comes back. A build plan near the TOP, thousands of turns above anything
  // ever mounted, so the gutter has to have marked a turn it has never drawn.
  const bigCwd = join(HERE, "big");
  const bigDir = join(OUT, escapeCwd(bigCwd));
  const bigSession = "00000000-fixture-0000-000000000008";
  await mkdir(bigDir, { recursive: true });
  await mkdir(bigCwd, { recursive: true });
  const BIG_TURNS = 2_600;
  const PLAN_AT = 12;
  const FRAME_AT = BIG_TURNS - 30;
  const bigRows: unknown[] = [];
  for (let i = 0; i < BIG_TURNS; i += 1) {
    const at = new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + i * 60_000).toISOString();
    bigRows.push({
      type: "user",
      uuid: `88888888-0000-0000-0000-${String(i * 2 + 1).padStart(12, "0")}`,
      parentUuid: null,
      timestamp: at,
      sessionId: bigSession,
      cwd: bigCwd,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: `turn ${String(i)} — what about this one?` }] },
    });
    const body =
      i === PLAN_AT
        ? `Here is the plan:\n\n\`\`\`plan\n${bigCwd}/big-plan.md\n\`\`\``
        : i === FRAME_AT
          ? `And the frame:\n\n\`\`\`iframe\n${bigCwd}/big-frame.html | 120\n\`\`\``
          : `Answer ${String(i)}. ${"Enough prose that a turn has a real height and the window has something to measure. ".repeat(2)}`;
    bigRows.push({
      type: "assistant",
      uuid: `88888888-0000-0000-0000-${String(i * 2 + 2).padStart(12, "0")}`,
      parentUuid: `88888888-0000-0000-0000-${String(i * 2 + 1).padStart(12, "0")}`,
      timestamp: at,
      sessionId: bigSession,
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: body }], stop_reason: "end_turn" },
    });
  }
  await Bun.write(
    join(bigCwd, "big-frame.html"),
    '<!doctype html><meta charset="utf-8"><body style="margin:0;font:12px sans-serif">a fixture frame</body>\n',
  );
  await Bun.write(
    join(bigCwd, "big-plan.md"),
    [
      "---",
      "id: 2026-08-23 · windowing fixture",
      "records: [loom-fixture-parent/project.md]",
      "size: S",
      "git: worktree fixture, off master",
      "work: [next 1]",
      "estimate: 1h",
      "---",
      "",
      "# A plan the gutter must mark from a turn it never drew",
      "",
      "## Log",
      "",
      "10:00 · written by the fixture",
      "",
    ].join("\n"),
  );
  const bigTarget = join(bigDir, `${bigSession}.jsonl`);
  await Bun.write(bigTarget, bigRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await utimes(bigTarget, older, older);
  console.log(`[fixture] wrote ${bigTarget} (${String(BIG_TURNS)} turns)`);

  // ── an input-capable project for the QUEUE pins (SPEC 138) ────────
  // Its own project for the same reason journey12-scroll got one: journey18 APPENDS a row to this
  // file mid-turn (that is the whole test — a message landing while an echo waits), and a shared
  // fixture growing under another spec's assertions is a proven way to fail somewhere unrelated.
  // cwd is `tests/fixture`, a directory that exists, because the Runner spawns the stub there.
  const queueCwd = HERE;
  const queueDir = join(OUT, escapeCwd(queueCwd));
  const queueSession = "00000000-fixture-0000-000000000007";
  await mkdir(queueDir, { recursive: true });
  const queueRows = [
    {
      type: "user",
      uuid: "77777777-0000-0000-0000-000000000001",
      parentUuid: null,
      timestamp: "2026-08-05T10:00:00.000Z",
      sessionId: queueSession,
      cwd: queueCwd,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "queue fixture opening turn" }] },
    },
    {
      type: "assistant",
      uuid: "77777777-0000-0000-0000-000000000002",
      parentUuid: "77777777-0000-0000-0000-000000000001",
      timestamp: "2026-08-05T10:00:05.000Z",
      sessionId: queueSession,
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "queue fixture: ready" }] },
    },
  ];
  const queueTarget = join(queueDir, `${queueSession}.jsonl`);
  await Bun.write(queueTarget, queueRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Backdated for the same reason as the two above: a bare `goto("/")` must not land here.
  await utimes(queueTarget, older, older);
  console.log(`[fixture] wrote ${queueTarget}`);

  // ── project records for the tree + tabs (SPEC §Records) ──────────
  // A parent with one child and one non-record bystander, under the loom root so the record tab's
  // /api/file fetch stays inside the test's readable roots.
  // Same reason as OUT above: the records ARE what the task specs write to, so a shared one is the
  // sharpest way for two concurrent runs to fail in each other's name.
  const recordsDir = Bun.env["LOOM_FIXTURE_RECORDS"] ?? join(HERE, ".records");
  await rm(recordsDir, { recursive: true, force: true });
  await mkdir(join(recordsDir, "loom-fixture-parent", "loom-fixture-child"), { recursive: true });
  await mkdir(join(recordsDir, "loom-fixture-parent", "loom-fixture-train"), { recursive: true });
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "project.md"),
    [
      "---",
      "type: project",
      "status: active",
      "created: 2026-08-04",
      "---",
      "",
      "# Fixture parent project",
      "",
      "**Need.** Prove the tree renders records.",
      "",
      // The optional Hypotheses section: one claim per standing the row has to draw differently,
      // plus one with no standing at all — loom renders that and never invents one.
      "## Hypotheses",
      "",
      "1. **A claim still being tested.** *Open*: nothing has come back yet.",
      "2. **A claim the evidence went against.** *Refuted 2026-08-05*: the scan returned everything.",
      "3. **A claim nobody gave a standing.**",
      "",
      "## Where it stands",
      "",
      "The child below reports back here.",
      "",
      // MARKDOWN TABLES, copied from the shapes User's real records carry — he reads his notes
      // through these and could not (2026-08-28). Three shapes, because they fail differently:
      // a plain prose table, one with an EMPTY first header cell (watch/jellyfin-clients), and one
      // INDENTED inside a numbered list item (dacha-wifi item 5).
      "| case | expected | got |",
      "| --- | --- | --- |",
      "| undeclared project file | block | exit 2, with the record path and the command |",
      "| file with no `project.md` above it | allow | exit 0 |",
      "| the record itself (`project.md`, `brief.md`) | allow | exit 0 — otherwise the unlock deadlocks |",
      "",
      "A second one, whose first header cell is empty:",
      "",
      "| | count |",
      "|---|---|",
      "| h264 8-bit video | 73 |",
      "| text subtitles (subrip / ass / mov_text) | 48 |",
      "",
      "1. **A measurement inside a numbered item** — the table is indented under the item, which is",
      "   how a run of numbers actually gets written down:",
      "",
      "   | | 2.4 GHz ch 11 | 5 GHz ch 36 | 08-04 baseline (5 GHz) |",
      "   |---|---|---|---|",
      "   | RSSI median | −63 dBm | −73 dBm | −69 dBm |",
      "   | PHY rx / tx median | 116 / 52 Mbit | 240 / 108 Mbit | 270 / 108 Mbit |",
      "   | ping to router, p95 | 31.7 ms | 3.5 ms | 3.8 ms |",
      "",
      "2. The item after it, so the list is a real list.",
      "",
      "The same shapes live in a NOTE too — [the table note](./table-note.md) — which the file pane",
      "renders down a different path.",
      "",
      // The task surface under test (SPEC §Tasks): one item per move the journey drives, plus a
      // boxless one — loom must render that as prose and offer a box, never guess a status.
      "## Next",
      "",
      "1. [ ] **Tick me to doing** — need: the box has to resemble the status.",
      "2. [ ] **Finish me with a result** — need: a done task carries what came of it.",
      "3. [ ] **Split me out** — need: a task that outgrew its line becomes a project.",
      "4. **A plain prose item** with no box at all.",
      "",
      "## Log",
      "",
      "- 2026-08-04 — the fixture was written.",
      "",
    ].join("\n"),
  );
  // A record with a TRAIN — two sessions in one line of work (SPEC §Train). Written before the
  // child so the child keeps the newer mtime and its position in the tree, which journey4 asserts.
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "loom-fixture-train", "project.md"),
    [
      "---",
      "type: project",
      "status: active",
      "created: 2026-08-07",
      "parent: ../project.md",
      "---",
      "",
      "# Fixture train project",
      "",
      "Two sessions, one line of work — the seam between them is what journey9 drives.",
      "",
    ].join("\n"),
  );
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "loom-fixture-child", "project.md"),
    [
      "---",
      "type: project",
      "status: framing",
      "created: 2026-08-05",
      "parent: ../project.md",
      "---",
      "",
      // Long on purpose: real records are titled "need — plan" and run past 80 characters, and the
      // tab strip only overflows once a title is that long (layout-holds, 2026-08-06). A short
      // fixture title is why both layout defects shipped green.
      "# Fixture child project — split out by hand and named the way the real ones are, need first",
      "",
      "Split out to prove the parent edge renders as nesting.",
      "",
    ].join("\n"),
  );
  // Two records the PANEL has to hide by default (SPEC 88–93), one per axis, so a tree that has
  // stopped filtering fails loudly instead of just looking a bit longer.
  await mkdir(join(recordsDir, "loom-fixture-parent", "loom-fixture-done"), { recursive: true });
  await mkdir(join(recordsDir, "loom-fixture-parent", "loom-fixture-child", "loom-fixture-dormant"), {
    recursive: true,
  });
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "loom-fixture-done", "project.md"),
    [
      "---",
      "type: project",
      "status: done",
      "created: 2026-08-05",
      "parent: ../project.md",
      "---",
      "",
      "# Fixture finished project",
      "",
      "Over, and folded away until asked for.",
      "",
    ].join("\n"),
  );
  // Old AND live: hidden by recency when the panel is wide open, and REVEALED by focusing its
  // parent — which is the whole claim that focus replaces the recency filter rather than stacking
  // with it. A record that were merely recent could not tell those two designs apart.
  const dormant = join(recordsDir, "loom-fixture-parent", "loom-fixture-child", "loom-fixture-dormant", "project.md");
  await Bun.write(
    dormant,
    [
      "---",
      "type: project",
      "status: active",
      "created: 2026-06-01",
      "parent: ../project.md",
      "---",
      "",
      "# Fixture dormant project",
      "",
      "Untouched for a month, and still the thing you want when you focus its parent.",
      "",
    ].join("\n"),
  );
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await utimes(dormant, longAgo, longAgo);
  await Bun.write(join(recordsDir, "loom-fixture-parent", "notes.md"), "# Not a record\n");
  // The cores' vault, MADE rather than assumed. `cwdFor` gives a record inside the vault its core's
  // cwd, and a record outside it its own directory. With the real vault that split depends on where
  // the checkout happens to sit: this repo lives IN the vault, so every fixture record counted as
  // vault-owned and its child was spawned in the real Personal Claude while the suite waited for a
  // reply in the fixture store — 11 pins red, in six specs that never mention cores. It is the exact
  // failure `cwdFor`'s own comment describes, reached the other way round, and it stayed invisible
  // because the builds all run from worktrees outside `~/resilio` (2026-08-29).
  //
  // `Spouse Claude` is deliberately NOT created: `usableCores` drops a core whose directory is missing,
  // and the selector's disabled Spouse row is what the core pins read.
  const coreVault = Bun.env["LOOM_CORE_VAULT"];
  if (coreVault !== undefined) {
    for (const core of ["claude", "Personal Claude"]) {
      await mkdir(join(coreVault, "Projects", core), { recursive: true });
    }
    console.log(`[fixture] wrote the cores' vault under ${coreVault}`);
  }
  // A NOTE with a table and a rich block. The file pane renders through `withSourceLines`, which
  // handed marked a bare options object and so lost GFM and the custom renderer with it: the table
  // came out as a paragraph of pipes and the plan block as plain code (2026-08-28).
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "table-note.md"),
    [
      "# A note with a table",
      "",
      "Prose before it, so the table is not the first thing in the file.",
      "",
      "| case | expected | got |",
      "| --- | --- | --- |",
      "| undeclared project file | block | exit 2 |",
      "| file with no record above it | allow | exit 0 |",
      "",
      "| | count |",
      "|---|---|",
      "| h264 8-bit video | 73 |",
      "",
      "And ~~struck-through~~ text, which is GFM too.",
      "",
      "```plan",
      join(recordsDir, "loom-fixture-parent", "fixture-visual-plan-2026-08-11.md"),
      "```",
      "",
      "Prose after.",
      "",
    ].join("\n"),
  );

  // ── prototypes (SPEC 133) ────────────────────────────────
  // A version chain in the parent and a single file in the child. The chain's v2 is the file the
  // parent transcript below EMBEDS, so the drawer's jump has a real introduction to land on; the
  // child's file is embedded nowhere, which is the degrade path the journey drives. The child
  // having its own file is also what makes "a child never shows its parent's prototypes" checkable
  // from the child's side.
  await mkdir(join(recordsDir, "loom-fixture-parent", "mockups"), { recursive: true });
  await mkdir(join(recordsDir, "loom-fixture-parent", "loom-fixture-child", "mockups"), { recursive: true });
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "mockups", "fixture-widget-2026-08-01.html"),
    "<!doctype html><p>fixture widget v1</p>\n",
  );
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "mockups", "fixture-widget-v2-bigger-2026-08-02.html"),
    "<!doctype html><p>fixture widget v2, the bigger one</p>\n",
  );
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "loom-fixture-child", "mockups", "child-proto-2026-08-03.html"),
    "<!doctype html><p>child prototype</p>\n",
  );
  // Not a document: the frame's error branch needs something loom refuses to DRAW, and an image
  // comes back as bytes, so the block's JSON parse fails without any HTTP error being logged.
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "mockups", "fixture-widget-shot-2026-08-02.png"),
    PNG_1X1,
  );
  // ── documents with no height of their own (SPEC 214) ──────────────
  //
  // A page whose root is `height:100%` reports the height of the FRAME, and loom's own stylesheet
  // (`* { box-sizing: border-box }` plus the frame's 1px border) makes the document's viewport two
  // pixels shorter than whatever is written to it — so each adopted report produces the next one,
  // 2px smaller, until the frame stands at its content's floor. Measured on the real build before
  // this fixture existed: 361 reports, 938 → 218, ~112px/s.
  //
  // `frames/`, NOT `mockups/`, on purpose: the prototype drawer is the `.html` files in a record's
  // `mockups/` (SPEC 134), so three test pages filed there would be three more prototypes in the
  // fixture parent's drawer and `journey17-protos`'s count would be answering for this build's
  // fixture rather than for the drawer. These are documents to frame, not prototypes of anything.
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "frames", "fixture-fills-window-2026-08-14.html"),
    `<!doctype html><meta charset="utf-8"><style>
  html, body { height: 100%; margin: 0; overflow: hidden; }
  .shell { height: 100%; display: flex; flex-direction: column; font: 13px system-ui; }
  .body { flex: 1 1 auto; overflow: auto; padding: 8px; }
</style>
<div class="shell"><div class="body"><p>fixture app shell — it fills whatever window it is given,
and has no height of its own to report</p></div></div>
`,
  );
  // The other direction, and the reason the echo rule alone is not enough: padding on a full-height
  // root reports what it was given PLUS 40, which escapes the 4px test and ratchets UP.
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "frames", "fixture-grows-forever-2026-08-14.html"),
    `<!doctype html><meta charset="utf-8"><style>
  html { height: 100%; padding: 20px; }
  body { margin: 0; font: 13px system-ui; }
</style>
<p>fixture page that reports 40px more than the frame it was given</p>
`,
  );
  // The two-sided half: an HONEST page that gets taller when he clicks it must still be followed.
  await Bun.write(
    join(recordsDir, "loom-fixture-parent", "frames", "fixture-grows-on-click-2026-08-14.html"),
    `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; font: 13px system-ui; }
  #more { display: none; height: 300px; background: #eef; }
</style>
<p>fixture page with an honest height</p>
<button id="go">show more</button>
<div id="more"></div>
<script>
  document.getElementById("go").addEventListener("click", function () {
    document.getElementById("more").style.display = "block";
  });
<\/script>
`,
  );
  console.log(`[fixture] wrote records under ${recordsDir}`);

  // A session belonging to the PARENT RECORD's directory — the store groups a record's sessions by
  // its cwd (workspace v1). It exists so the record tab has real file touches to offer as a done
  // task's artifacts: the change-object side of a result is derived, never typed.
  const parentDir = join(recordsDir, "loom-fixture-parent");
  const parentStore = join(OUT, escapeCwd(parentDir));
  const parentSession = "00000000-fixture-0000-000000000003";
  await mkdir(parentStore, { recursive: true });
  // RELATIVE, not a fixed date: the tree's ring means "typed here inside 24h", so a hardcoded
  // timestamp makes journey4's ring assertion pass until it is a day old and then fail with
  // nothing changed (it did, 2026-08-06).
  const typedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const touchRows = [
    {
      type: "user",
      uuid: "44444444-0000-0000-0000-000000000001",
      parentUuid: null,
      timestamp: typedAt.toISOString(),
      sessionId: parentSession,
      cwd: parentDir,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "do the work item" }] },
    },
    {
      type: "assistant",
      uuid: "44444444-0000-0000-0000-000000000002",
      parentUuid: "44444444-0000-0000-0000-000000000001",
      timestamp: new Date(typedAt.getTime() + 10_000).toISOString(),
      sessionId: parentSession,
      isSidechain: false,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_fx_task_w", name: "Write", input: { file_path: REAL_FILE } },
          {
            type: "tool_use",
            id: "toolu_fx_task_e",
            name: "Edit",
            input: { file_path: join(REAL_DIR, "SPEC.md") },
          },
          { type: "text", text: "**Done.** Two files touched." },
        ],
      },
    },
    // The prototype's INTRODUCTION — the first row in the store naming the v2 file. The drawer's
    // jump must land here, and a fixture without one could only drive the failure toast.
    {
      type: "user",
      uuid: "44444444-0000-0000-0000-000000000003",
      parentUuid: "44444444-0000-0000-0000-000000000002",
      timestamp: new Date(typedAt.getTime() + 20_000).toISOString(),
      sessionId: parentSession,
      cwd: parentDir,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "show me the widget mockup" }] },
    },
    {
      type: "assistant",
      uuid: "44444444-0000-0000-0000-000000000004",
      parentUuid: "44444444-0000-0000-0000-000000000003",
      timestamp: new Date(typedAt.getTime() + 30_000).toISOString(),
      sessionId: parentSession,
      isSidechain: false,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            // Two frames in ONE message, deliberately. A second ROW shifts every spec that counts
            // messages in this session, and a frame pointed at an ABSENT file answers 400 — which
            // no other spec's error filter tolerates. Six specs failed on each mistake in turn
            // (2026-08-14). A frame pointed at an image is the third try: the fetch succeeds, the
            // JSON parse does not, so the error branch runs with no HTTP noise at all. That branch
            // is SPEC 205's second half — without a pin on it the anchor could be dropped from the
            // failure path and nothing would notice.
            // The four frames after these two are SPEC 214's, and they are in this same message for
            // the same reason: a new row shifts every spec that counts messages here. Their order is
            // load-bearing — `journey25-steady` takes `.first()`, which must stay the widget.
            text: `Here it is:\n\n\`\`\`iframe\n${join(parentDir, "mockups", "fixture-widget-v2-bigger-2026-08-02.html")} | 200\n\`\`\`\n\nAnd one loom will not draw:\n\n\`\`\`iframe\n${join(parentDir, "mockups", "fixture-widget-shot-2026-08-02.png")} | 200\n\`\`\`\n\nA page that fills its window, with a height declared:\n\n\`\`\`iframe\n${join(parentDir, "frames", "fixture-fills-window-2026-08-14.html")} | 620\n\`\`\`\n\nThe same page with no height declared:\n\n\`\`\`iframe\n${join(parentDir, "frames", "fixture-fills-window-2026-08-14.html")}\n\`\`\`\n\nOne that reports more than it is given:\n\n\`\`\`iframe\n${join(parentDir, "frames", "fixture-grows-forever-2026-08-14.html")} | 300\n\`\`\`\n\nAnd one that grows when he clicks it:\n\n\`\`\`iframe\n${join(parentDir, "frames", "fixture-grows-on-click-2026-08-14.html")}\n\`\`\``,
          },
        ],
      },
    },
  ];

  // ── a plan with pictures in all three places (SPEC 165–168) ──────
  //
  // Record item 9: the plan block had parser properties and nothing that opens a browser, so four
  // visible defects survived a green suite twice. This is the fence those pins drive.
  const planDir = join(parentDir, "mockups");
  await Bun.write(join(planDir, "shot.png"), PNG_1X1);
  await Bun.write(
    join(planDir, "sheet.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">' +
      '<rect width="120" height="40" fill="#eef"/><circle cx="20" cy="20" r="8" fill="#2e7d32"/></svg>\n',
  );
  const planFile = join(parentDir, "fixture-visual-plan-2026-08-11.md");
  await Bun.write(
    planFile,
    [
      "---",
      "id: 2026-08-11 · fixture",
      "records: [loom-fixture-parent/project.md]",
      "size: S",
      "git: worktree fixture, off master",
      "work: [next 1]",
      "estimate: 1h",
      "prototype: mockups/fixture-widget-v2-bigger-2026-08-02.html",
      "---",
      "",
      "# A plan that shows things",
      "",
      "## Objects",
      "",
      "### 1 · The picture that loads",
      "kind: new",
      "what it is: An SVG, which only comes back as an image under `raw=1`.",
      "visual: `mockups/sheet.svg`",
      "",
      "### 2 · The picture that is not there",
      "kind: new · failure",
      "what it is: A path nobody can read.",
      "visual: `mockups/gone-2026-08-11.png`",
      "",
      "## Log",
      "",
      "The third place is a paragraph that is only an image:",
      "",
      "![the tile](mockups/shot.png)",
      "",
      "10:00 · written during the build",
      "",
    ].join("\n"),
  );
  touchRows.push({
    type: "user",
    uuid: "44444444-0000-0000-0000-000000000005",
    parentUuid: "44444444-0000-0000-0000-000000000004",
    timestamp: new Date(typedAt.getTime() + 40_000).toISOString(),
    sessionId: parentSession,
    cwd: parentDir,
    gitBranch: "master",
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text: "show me the plan" }] },
  });
  touchRows.push({
    type: "assistant",
    uuid: "44444444-0000-0000-0000-000000000006",
    parentUuid: "44444444-0000-0000-0000-000000000005",
    timestamp: new Date(typedAt.getTime() + 50_000).toISOString(),
    sessionId: parentSession,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Ready:\n\n\`\`\`plan\n${planFile}\n\`\`\`` }],
    },
  });

  // ── the chip kinds, in one real message (SPEC 139–142) ───────────
  //
  // Every kind the label rule has to tell apart, in the prose a session actually writes. The two
  // `notes.md` files are the point of the owner suffix: one name, two projects, and before this the
  // reader got the same word twice. The tilde path is written as a tilde ON PURPOSE — it is the one
  // shape that used to be dead on arrival (400 "absolute path required"), so a fixture with an
  // expanded path here could not fail on the defect.
  const childDir = join(recordsDir, "loom-fixture-parent", "loom-fixture-child");
  await Bun.write(join(childDir, "notes.md"), "# Child notes\n\nSecond file with the same name.\n");
  await Bun.write(
    join(parentDir, "lines.txt"),
    ["first line", "second line", "third line — the one a :3 chip lands on", "fourth line"].join("\n") + "\n",
  );
  await Bun.write(
    join(parentDir, "headings.md"),
    ["# Fixture headings", "", "Before.", "", "## Out of scope", "", "The section a #out-of-scope chip lands on.", ""].join("\n"),
  );
  const tildePath = `~/${relative(homedir(), REAL_FILE)}`;
  const kindRows = [
    {
      type: "user",
      // 7 and 8, not 5 and 6. This block was copied from the plan rows above and kept their ids, so
      // two DIFFERENT messages carried one uuid inside one session — which the format forbids (a
      // uuid IS the row) and which the client now leans on: a repeated uuid is a row the CLI wrote
      // again, and the renderer draws it once. Real transcripts do this constantly — 979 repeats in
      // one measured session, every one byte-identical — so the fixture was asserting a file no CLI
      // would ever produce, and four pins failed the moment the client believed the rule.
      uuid: "44444444-0000-0000-0000-000000000007",
      parentUuid: "44444444-0000-0000-0000-000000000006",
      timestamp: new Date(typedAt.getTime() + 40_000).toISOString(),
      sessionId: parentSession,
      cwd: parentDir,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "where does everything live?" }] },
    },
    {
      type: "assistant",
      uuid: "44444444-0000-0000-0000-000000000008",
      parentUuid: "44444444-0000-0000-0000-000000000007",
      timestamp: new Date(typedAt.getTime() + 50_000).toISOString(),
      sessionId: parentSession,
      isSidechain: false,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              `Two records: ${join(parentDir, "project.md")} and ${join(childDir, "project.md")}.`,
              `Two notes with one name: ${join(parentDir, "notes.md")} and ${join(childDir, "notes.md")}.`,
              `A directory: ${join(parentDir, "mockups")}/`,
              `A heading: ${join(parentDir, "headings.md")}#out-of-scope`,
              `A line: ${join(parentDir, "lines.txt")}:3`,
              `A tilde path: ${tildePath}`,
              // Relative, and deliberately NOT present under the session's own directory: it only
              // resolves by climbing to an ancestor, which is the whole of SPEC 143.
              "A relative path: `client/markdown.ts`",
              "An outside link: [the fixture link](https://example.com/fixture-link)",
              // ── the false-chip shapes (SPEC 223) ───────────────────────
              // Every one of these used to render as a clickable link to nothing.
              `Two paths, one space: ls ${parentDir} ${childDir}`,
              `A prompt: user@nixos:${tildePath}$ ls`,
              `A file that is not there: ${join(parentDir, "nope-not-a-real-file.md")}`,
              // REAL_DIR is loom's own directory, and its path really does carry a space
              // ("Personal Claude"), which is the shape User's whole vault has. A segment walk
              // cuts it at that space and produces a link to `…/Projects/Personal`; the known-
              // directory rule puts it back, from the record list already in memory (SPEC 223).
              `An unquoted command: cd ${REAL_DIR} && bun test`,
              // ── the kinds this build added (link-kinds-2026-08-19.md) ──
              // A work item, in the exact form CLAUDE.md rule 45 mandates — every task link written
              // to User was dead because the place suffix could not carry a space (kind 17).
              `A work item: ${join(parentDir, "project.md")}#next 1`,
              // A line RANGE, which used to land on the first line and lose the span silently (7).
              `A line range: ${join(parentDir, "lines.txt")}:2-4`,
              // A relative DIRECTORY: never a chip at all before, because a path with no extension
              // and no leading slash had nothing to declare itself with (5).
              "A relative directory: `client/`",
              // A vault wikilink — the form vault notes link to each other with (11).
              "A vault note: [[ARCHITECTURE]]",
              // loom's own address: caught as an external link and opened in a second tab (9).
              `A loom link: [back to the child](<http://localhost:${Bun.env["LOOM_PORT"] ?? "4180"}/?record=${encodeURIComponent(join(childDir, "project.md"))}>)`,
              // A local-file URL, which the browser refuses to navigate from an http page (20).
              // Angle brackets around the destination: this path really does contain a space
              // ("Personal Claude"), and a bare markdown destination ends at one.
              `A file URL: [the fixture lines](<file://${join(parentDir, "lines.txt")}>)`,
              // Refused, and the refusal has to name a way out (12). This used to be `/etc/hostname`;
              // item 15 widened the roots to the machine, so the shape that still refuses is a
              // DENIED one — the deny list is what says no now.
              "A denied file: ~/.ssh/id_ed25519",
              // ── the kinds the 2026-08-24 audit found broken ────────────
              // A prototype opened as highlighted markup instead of as a page — 24 links (item 10).
              `A prototype: ${join(parentDir, "mockups", "fixture-widget-2026-08-01.html")}`,
              // A place suffix on a WRITTEN link was never split off, so the server was asked for a
              // file whose name ends in `:3` — 147 links, the form rule 45 mandates (item 12).
              `A written line link: [the third line](<${join(parentDir, "lines.txt")}:3>)`,
              // A line inside a RECORD had nothing to land on once the record was rendered — 44
              // links (item 13). Line 7 of headings.md is the paragraph under "Out of scope".
              `A line in a record: ${join(parentDir, "headings.md")}:7`,
              // GitHub's own line form, which read as a heading and could only ever miss.
              `A github line: ${join(parentDir, "lines.txt")}#L3`,
            ].join("\n\n"),
          },
        ],
      },
    },
  ];
  touchRows.push(...kindRows);

  const parentTarget = join(parentStore, `${parentSession}.jsonl`);
  await Bun.write(parentTarget, touchRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Backdated for the same reason as the input fixture: a bare `goto("/")` must still open the
  // journey's own project, and boot lands on the most recently active one.
  await utimes(parentTarget, older, older);
  console.log(`[fixture] wrote ${parentTarget}`);

  // ── a train: two sessions in one record's store (SPEC §Train) ────
  //
  // Relative timestamps, not fixed ones, for the same reason the ring above is relative: the cache
  // mark is a countdown against a real clock, so a hardcoded date makes the WARM half of the
  // assertion pass today and fail tomorrow with nothing changed.
  //
  // Two-sided by construction — the older car's last call is hours past its 1-hour bucket (cold),
  // the newer car's is ten minutes old (still cached). A fixture where both cars said the same
  // thing could not tell a working mark from one stuck on a constant.
  const trainDir = join(recordsDir, "loom-fixture-parent", "loom-fixture-train");
  const trainStore = join(OUT, escapeCwd(trainDir));
  await mkdir(trainStore, { recursive: true });

  const usage = (read: number, write: number) => ({
    input_tokens: 3,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 },
  });

  const car = (
    id: string,
    uuidPrefix: string,
    openedAt: Date,
    calledAt: Date,
    said: string,
    tokens: { read: number; write: number },
    /**
     * Turns of filler after the real ones. A car has to be TALLER THAN THE VIEWPORT for "the new
     * seam is on screen after the cut" to be a check at all: with two short cars the seam is in
     * view whether or not the scroll is right, and the mutation proving that assertion could fail
     * survived (2026-08-07). Filler rows carry no usage, so the cost mark still reads the real call.
     */
    filler = 0,
  ): unknown[] => [
    {
      type: "user",
      uuid: `${uuidPrefix}-0000-0000-0000-000000000001`,
      parentUuid: null,
      timestamp: openedAt.toISOString(),
      sessionId: id,
      cwd: trainDir,
      gitBranch: "master",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: said }] },
    },
    {
      type: "assistant",
      uuid: `${uuidPrefix}-0000-0000-0000-000000000002`,
      parentUuid: `${uuidPrefix}-0000-0000-0000-000000000001`,
      timestamp: calledAt.toISOString(),
      sessionId: id,
      isSidechain: false,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `**Noted.** ${said}` }],
        usage: usage(tokens.read, tokens.write),
      },
    },
    // A subagent's accounting, newer than the real one and much smaller: the mark must ignore it
    // (train property 3). Without this row the fixture could not tell the two apart.
    {
      type: "assistant",
      uuid: `${uuidPrefix}-0000-0000-0000-000000000003`,
      parentUuid: `${uuidPrefix}-0000-0000-0000-000000000002`,
      timestamp: new Date(calledAt.getTime() + 5_000).toISOString(),
      sessionId: id,
      isSidechain: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "subagent chatter" }],
        usage: usage(400, 100),
      },
    },
    ...Array.from({ length: filler * 2 }, (_, i) => {
      const mine = i % 2 === 0;
      return {
        type: mine ? "user" : "assistant",
        uuid: `${uuidPrefix}-0000-0000-0000-${String(100 + i).padStart(12, "0")}`,
        parentUuid: `${uuidPrefix}-0000-0000-0000-${String(99 + i).padStart(12, "0")}`,
        timestamp: new Date(calledAt.getTime() + 10_000 + i * 1000).toISOString(),
        sessionId: id,
        isSidechain: false,
        message: {
          role: mine ? "user" : "assistant",
          content: [{ type: "text", text: `filler turn ${String(i)} — enough height to scroll` }],
        },
      };
    }),
  ];

  const now = Date.now();
  const firstCar = car(
    "00000000-fixture-0000-000000000005",
    "55555555",
    new Date(now - 3 * 60 * 60 * 1000),
    new Date(now - 2.9 * 60 * 60 * 1000),
    "the first car of this train",
    { read: 61_000, write: 9_000 },
  );
  const secondCar = car(
    "00000000-fixture-0000-000000000006",
    "66666666",
    new Date(now - 30 * 60 * 1000),
    new Date(now - 10 * 60 * 1000),
    "the newest car of this train",
    { read: 118_000, write: 2_000 },
    18,
  );

  const firstTarget = join(trainStore, "00000000-fixture-0000-000000000005.jsonl");
  const secondTarget = join(trainStore, "00000000-fixture-0000-000000000006.jsonl");
  await Bun.write(firstTarget, firstCar.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await Bun.write(secondTarget, secondCar.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Backdated like every other fixture store so a bare goto("/") still opens the journey's own
  // project — but the second car keeps the newer mtime, because that is what loom lands on.
  await utimes(firstTarget, older, older);
  await utimes(secondTarget, new Date(older.getTime() + 2000), new Date(older.getTime() + 2000));
  console.log(`[fixture] wrote a two-car train under ${trainStore}`);

  // A SECOND train, for the recap spec alone (SPEC §Recap). It gets its own record because the recap
  // journey ends by starting a real session — and a spec that adds a car to a fixture other specs
  // count is a spec that breaks them. It did: journey9 saw three seams where it asserts two, and
  // journey2 saw a turn that would not finish (2026-08-12, caught by the full suite, not by the
  // recap spec running alone).
  const recapDir = join(recordsDir, "loom-fixture-parent", "loom-fixture-recap");
  const recapStore = join(OUT, escapeCwd(recapDir));
  await mkdir(recapDir, { recursive: true });
  await mkdir(recapStore, { recursive: true });
  await Bun.write(
    join(recapDir, "project.md"),
    [
      "---",
      "type: project",
      "status: active",
      "created: 2026-08-12",
      "parent: ../project.md",
      "---",
      "",
      "# Fixture recap project",
      "",
      "## Where it stands",
      "",
      "One session, finished. The recap spec cuts a seam here.",
      "",
      "## Next",
      "",
      "1. [ ] be recapped",
      "",
    ].join("\n"),
  );
  const recapCar = car(
    "00000000-fixture-0000-000000000008",
    "88888888",
    new Date(now - 2 * 60 * 60 * 1000),
    new Date(now - 1.9 * 60 * 60 * 1000),
    "the session the recap spec reads",
    { read: 40_000, write: 4_000 },
    4,
  );
  const recapTarget = join(recapStore, "00000000-fixture-0000-000000000008.jsonl");
  await Bun.write(
    recapTarget,
    recapCar.map((r) => JSON.stringify({ ...(r as object), cwd: recapDir })).join("\n") + "\n",
  );
  await utimes(recapTarget, older, older);
  console.log(`[fixture] wrote a one-car train for the recap spec under ${recapStore}`);

  // A THIRD train, for the restore spec (requirement 179): two cars and a ledger already written,
  // and no recap ever run in this process. That is exactly the state a restart leaves behind — the
  // entry on disk, the server's memory empty — and it is the only way to drive the restore without
  // killing the server Playwright is managing. The ledger holds a SUPERSEDED entry as well, so a
  // reader that shows every entry instead of the newest per session fails the spec.
  const restoreDir = join(recordsDir, "loom-fixture-parent", "loom-fixture-restore");
  const restoreStore = join(OUT, escapeCwd(restoreDir));
  await mkdir(restoreDir, { recursive: true });
  await mkdir(restoreStore, { recursive: true });
  await Bun.write(
    join(restoreDir, "project.md"),
    [
      "---",
      "type: project",
      "status: active",
      "created: 2026-08-13",
      "parent: ../project.md",
      "---",
      "",
      "# Fixture restored recap project",
      "",
      "## Where it stands",
      "",
      "Two sessions, and a ledger written before loom was restarted.",
      "",
      "## Next",
      "",
      "1. [ ] show the block again",
      "",
    ].join("\n"),
  );
  const restoreOld = car(
    "00000000-fixture-0000-000000000010",
    "aaaaaaaa",
    new Date(now - 4 * 60 * 60 * 1000),
    new Date(now - 3.9 * 60 * 60 * 1000),
    "the car the ledger is about",
    { read: 40_000, write: 4_000 },
    4,
  );
  const restoreNew = car(
    "00000000-fixture-0000-000000000011",
    "bbbbbbbb",
    new Date(now - 3 * 60 * 60 * 1000),
    new Date(now - 2.9 * 60 * 60 * 1000),
    "the car that should show the block",
    { read: 40_000, write: 4_000 },
    4,
  );
  const restoreOldTarget = join(restoreStore, "00000000-fixture-0000-000000000010.jsonl");
  const restoreNewTarget = join(restoreStore, "00000000-fixture-0000-000000000011.jsonl");
  await Bun.write(
    restoreOldTarget,
    restoreOld.map((r) => JSON.stringify({ ...(r as object), cwd: restoreDir })).join("\n") + "\n",
  );
  await Bun.write(
    restoreNewTarget,
    restoreNew.map((r) => JSON.stringify({ ...(r as object), cwd: restoreDir })).join("\n") + "\n",
  );
  await utimes(restoreOldTarget, older, older);
  await utimes(restoreNewTarget, new Date(older.getTime() + 2000), new Date(older.getTime() + 2000));
  await Bun.write(
    join(restoreDir, "recap-ledger.md"),
    [
      "<!-- recap: session: 00000000-fixture-0000-000000000010 · written: 2026-08-13T09:00:00.000Z · at-turn: 4 -->",
      "",
      "## the car the ledger is about",
      "",
      "# State",
      "",
      "SUPERSEDED: the first pass, which a reader showing every entry would put on screen.",
      "",
      "# Open threads",
      "",
      "1. Nothing — this entry was replaced.",
      "",
      "<!-- recap: session: 00000000-fixture-0000-000000000010 · written: 2026-08-13T10:00:00.000Z · at-turn: 4 · supersedes: 2026-08-13T09:00:00.000Z -->",
      "",
      "## the car the ledger is about",
      "",
      "# State",
      "",
      "RESTORED: written to the ledger before loom was restarted, and read back from it.",
      "",
      "# Open threads",
      "",
      "1. Prove the block comes back from the file.",
      "",
    ].join("\n"),
  );
  console.log(`[fixture] wrote a two-car train and a ledger for the restore spec under ${restoreStore}`);

  // Pre-authenticated browser state for the driven specs: every data route requires the device
  // token (SPEC invariant 7), and the specs assert app behaviour, not the login flow — the login
  // flow has its own spec that starts from an EMPTY storage state.
  const token = Bun.env["LOOM_TOKEN"];
  if (token !== undefined && token.length > 0) {
    const storage = {
      cookies: [
        {
          name: "loom_token",
          value: token,
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    };
    // NOT under test-results: that is Playwright's outputDir, and it is wiped after the webServer
    // (this script) has run — so the cookie written here vanished before the first test read it,
    // and every run after the first failed with ENOENT (2026-08-06).
    // Either spelling: a full path, or the directory to put it in. Two sessions slotted this
    // harness at the same time and kept renaming each other's variable — accepting both ends that
    // argument for the price of one `??`.
    const auth = Bun.env["LOOM_FIXTURE_AUTH"];
    const storagePath =
      Bun.env["LOOM_STORAGE_STATE"] ??
      (auth === undefined
        ? join(HERE, "..", ".state", "storage-state.json")
        : join(auth, "storage-state.json"));
    await mkdir(dirname(storagePath), { recursive: true });
    await Bun.write(storagePath, JSON.stringify(storage));
    console.log(`[fixture] wrote ${storagePath}`);
  }
}

await main();
