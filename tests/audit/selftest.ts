/**
 * Show the audit failing on purpose before believing it when it passes (build skill, "Show the check
 * failing before believing it passes").
 *
 * Builds a two-message transcript store of its own — one link that must be judged fine, five that
 * must each land in a named group — runs the whole audit against it, and reads the report back. A
 * run that reports nothing here is a broken audit, not a clean codebase.
 *
 *   bun tests/audit/selftest.ts
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function row(text: string, cwd: string, n: number): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u${n}`,
    parentUuid: n === 1 ? null : `u${n - 1}`,
    timestamp: "2026-08-24T12:00:00.000Z",
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd,
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
  });
}

async function main(): Promise<void> {
  const box = await mkdtemp(join(tmpdir(), "loom-audit-selftest-"));
  const store = join(box, "projects", "-selftest");
  const files = join(box, "files");
  await mkdir(store, { recursive: true });
  await mkdir(join(files, "mockups"), { recursive: true });

  // The world the links point into. Each case that must be judged FINE gets its OWN file, so the
  // two-sided check below can look for that filename in the report and mean it.
  await writeFile(join(files, "fine-record.md"), "# Title\n\n## A heading\n\nbody\n", "utf8");
  await writeFile(join(files, "notes.md"), "# Title\n\n## A heading\n\nbody\n", "utf8");
  const twenty = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  await writeFile(join(files, "fine-bare.ts"), twenty, "utf8");
  await writeFile(join(files, "fine-written.ts"), twenty, "utf8");
  await writeFile(join(files, "code.ts"), twenty, "utf8");
  await writeFile(join(files, "mockups", "fine-proto-2026-08-24.html"), "<!doctype html><p>hi</p>\n", "utf8");

  const cases: Array<{ text: string; wants: string }> = [
    // ── judged FINE. Each names a file no failing case uses. ──────────
    { text: `Fine: ${join(files, "fine-bare.ts")}:5`, wants: "ok" },
    // SPEC 242. This was `place-never-split` until 2026-08-24, and it is the form rule 45 mandates.
    { text: `[fine-written.ts](${join(files, "fine-written.ts")}:5) — a labelled link`, wants: "ok" },
    // SPEC 241. This was `html-as-source`.
    { text: `A prototype: ${join(files, "mockups", "fine-proto-2026-08-24.html")}`, wants: "ok" },
    // SPEC 243. This was `line-in-rendered-markdown`.
    { text: `A line in a record: ${join(files, "fine-record.md")}:3`, wants: "ok" },
    // ── planted FAILURES, each of which must still be found ───────────
    { text: `A missing heading: ${join(files, "notes.md")}#nowhere`, wants: "heading-not-found" },
    { text: `Past the end: ${join(files, "code.ts")}:9999`, wants: "line-past-end" },
    { text: `Gone: ${join(files, "deleted.md")}`, wants: "server-refused" },
  ];

  await writeFile(
    join(store, "11111111-2222-3333-4444-555555555555.jsonl"),
    `${cases.map((c, i) => row(c.text, files, i + 1)).join("\n")}\n`,
    "utf8",
  );

  const out = join(box, "report.md");
  const run = Bun.spawn(
    [
      "bun", resolve(HERE, "link-audit.ts"),
      "--root", join(box, "projects"),
      "--out", out,
      "--port", "4395",
      "--roots", box,
    ],
    { cwd: resolve(HERE, "..", ".."), stdout: "pipe", stderr: "pipe" },
  );
  const code = await run.exited;
  const said = await new Response(run.stdout as ReadableStream).text();
  const cried = await new Response(run.stderr as ReadableStream).text();
  console.log(said.trim());
  if (code !== 0) {
    console.error(cried.trim());
    console.error(`\nSELFTEST FAILED: the audit exited ${code}`);
    process.exit(1);
  }

  const report = await readFile(out, "utf8");
  const missing = [...new Set(cases.map((c) => c.wants))]
    .filter((want) => want !== "ok")
    .filter((want) => !report.includes(want));
  // Two-sided: a case planted as FINE must not appear in the report at all. Without this the
  // selftest could be satisfied by an audit that calls everything broken.
  const wrong = ["fine-bare.ts", "fine-written.ts", "fine-proto-2026-08-24.html", "fine-record.md"].filter(
    (name) => report.includes(name),
  );

  console.log(report);
  if (missing.length > 0) {
    console.error(`SELFTEST FAILED: the report never named ${missing.join(", ")}`);
    process.exit(1);
  }
  if (wrong.length > 0) {
    console.error(`SELFTEST FAILED: planted as fine but reported broken — ${wrong.join(", ")}`);
    process.exit(1);
  }
  if (!/links found: \*\*[1-9]/.test(report)) {
    console.error("SELFTEST FAILED: the coverage witness says zero links were found");
    process.exit(1);
  }
  console.log(`SELFTEST PASSED — every planted failure was named. Store: ${box}`);
  await rm(box, { recursive: true, force: true });
}

await main();
