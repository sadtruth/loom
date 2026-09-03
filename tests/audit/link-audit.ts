/**
 * The link audit — build plan `tools/loom/projects/smart-links/link-audit-plan-2026-08-24.md`.
 *
 * Reads every message the assistant ever posted, renders each one through loom's OWN markdown
 * module in a real browser, asks a throwaway loom server about every chip it produced, and writes a
 * report grouped by cause.
 *
 *   bun tests/audit/link-audit.ts [--limit N] [--out FILE] [--port N] [--root DIR]
 *
 * It never writes to the transcript store and never talks to the loom on 4173.
 */

import { chromium, type Browser } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harvest, type HarvestStats, type Posted } from "./harvest.ts";
import { family, judge, slug, type Cause, type ChipFacts, type ServerAnswer } from "./verdict.ts";
import { enclosingRecord, type RecordLike } from "../../client/chips.ts";

// `pathname` percent-encodes the space in "Personal Claude", which is a directory that does not
// exist — every spawn from it fails with a bare ENOENT naming the binary rather than the cwd.
// The box exports HTTP_PROXY=127.0.0.1:11808 and `fetch` honours it, so every request to the
// throwaway server goes out through the proxy and comes back a minute later — measured 85s just to
// notice loom was already up. The pins config exempts loopback for the same reason.
process.env["NO_PROXY"] = "localhost,127.0.0.1,::1";
process.env["no_proxy"] = "localhost,127.0.0.1,::1";

// NixOS cannot run Playwright's downloaded chromium (no libglib in the closure), so on the box the
// audit drives the system one, exactly as the pins do. Absent on the Mac, where the bundled browser
// works — hence a conditional and not a hard path.
const CHROMIUM = process.env["PIN_CHROMIUM"] ?? "/run/current-system/sw/bin/chromium";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOOM = resolve(HERE, "..", "..");

interface Args {
  limit: number;
  out: string;
  port: number;
  root: string;
  /** Colon-separated read roots for the throwaway server; defaults to what the real loom serves. */
  roots: string;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? (argv[at + 1] ?? null) : null;
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    limit: Number.parseInt(get("limit") ?? "0", 10) || 0,
    out: get("out") ?? resolve(LOOM, "projects", "smart-links", `link-audit-${today}.md`),
    port: Number.parseInt(get("port") ?? "4399", 10),
    root: get("root") ?? join(process.env["HOME"] ?? "", ".claude", "projects"),
    // Empty means "do not set LOOM_ROOTS", so the server uses its own default. Pinning the old
    // pair here would have hidden item 15 from the re-run entirely.
    roots: get("roots") ?? "",
    quiet: argv.includes("--quiet"),
  };
}

/** What one chip turned into, kept flat so the report can group and count. */
interface Judged {
  cause: Cause;
  says: string;
  raw: string;
  path: string;
  place: string | null;
  label: string;
  form: string;
  session: string;
  when: string;
}

/** The shape `render-entry.ts` hands back. */
interface FoundLink {
  raw: string;
  path: string;
  place: string | null;
  label: string;
  fixed: boolean;
  wiki: boolean;
  anchor: { href: string; target: string } | null;
}

/**
 * A partial report is worse than none, so a server that will not start ends the run — and it ends it
 * carrying the server's OWN stderr, because "did not come up" on its own sends the reader looking in
 * the wrong file.
 */
async function waitForServer(server: Bun.Subprocess, port: number, token: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      // `/api/build` answers before the record scan finishes, and `/api/records` then 503s. Waiting
      // on the records route instead is waiting for the thing the audit actually needs.
      const response = await fetch(`http://127.0.0.1:${port}/api/records`, {
        headers: { cookie: `loom_token=${token}` },
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      const said = await new Response(server.stderr as ReadableStream).text().catch(() => "");
      throw new Error(`loom did not come up on ${port} within ${ms}ms\n${said.trim()}`);
    }
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * The chip pipeline is not the only thing that decides what a link does — `chipPathLinks` needs
 * `looksLikePath`, `labelChips` needs the record list, and the click handler needs to know whether
 * the path IS a record. All three come from the running server, so the audit uses the same list the
 * chat window would have.
 */
async function loadRecords(port: number, token: string): Promise<RecordLike[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/records`, {
    headers: { cookie: `loom_token=${token}` },
  });
  if (!response.ok) throw new Error(`/api/records answered ${response.status}`);
  return (await response.json()) as RecordLike[];
}

/** `Next` item numbers a record file carries, so a `#next 12` chip can be checked against reality. */
function itemsOf(text: string): number[] {
  const start = text.indexOf("\n## Next");
  if (start < 0) return [];
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const out: number[] = [];
  for (const line of (end < 0 ? rest : rest.slice(0, end)).split("\n")) {
    const item = /^(\d+)\.\s+\[[ x/\->]\]/.exec(line);
    if (item?.[1] !== undefined) out.push(Number.parseInt(item[1], 10));
  }
  return out;
}

/**
 * Ask the server about one path, exactly as `showFile` would. Only a chip carrying a PLACE needs
 * the file's contents; everything else needs the status alone, so the body is dropped unread.
 */
async function ask(
  port: number,
  token: string,
  path: string,
  base: string | null,
  needBody: boolean,
  record: string | null = null,
): Promise<ServerAnswer> {
  const wiki = path.startsWith("wiki:") ? path.slice("wiki:".length) : null;
  const query = wiki !== null
    ? `wiki=${encodeURIComponent(wiki.split("#")[0] ?? wiki)}`
    : `path=${encodeURIComponent(path)}${base === null ? "" : `&base=${encodeURIComponent(base)}`}` +
      `${record === null ? "" : `&record=${encodeURIComponent(record)}`}`;

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/file?${query}`, {
      headers: { cookie: `loom_token=${token}` },
    });
  } catch (error) {
    return { status: 0, reason: `could not read: ${String(error)}`, kind: null, lines: null, headings: null };
  }

  if (!response.ok) {
    return { status: response.status, reason: (await response.text()).trim(), kind: null, lines: null, headings: null };
  }
  if (!needBody) {
    await response.body?.cancel();
    return { status: 200, reason: "", kind: null, lines: null, headings: null };
  }

  const file = (await response.json()) as { kind: string; text?: string; entries?: unknown[] };
  const text = file.text ?? "";
  const known = ["markdown", "dir", "image", "binary", "page"] as const;
  const kind = (known as readonly string[]).includes(file.kind)
    ? (file.kind as ServerAnswer["kind"])
    : "text";
  const headings = kind === "markdown"
    ? [...text.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((m) => slug((m[1] ?? "").trim()))
    : null;
  // A rendered document has lines to land on now (SPEC 243), so it needs the count too.
  const lines = kind === "text" || kind === "markdown" ? text.split("\n").length : null;
  return { status: 200, reason: "", kind, lines, headings };
}

/** The session a batch came from, for the progress line. */
function message0(batch: readonly Posted[]): string {
  return (batch[0]?.session ?? "").slice(0, 8);
}

/** How the link was WRITTEN, inferred from the source text — labelled as inference in the report. */
function formOf(source: string, link: FoundLink): string {
  if (link.anchor !== null) return /^[a-z][a-z0-9+.-]*:/i.test(link.anchor.href) ? "external link" : "bare anchor";
  if (link.wiki) return "[[wiki link]]";
  if (!link.fixed) return "bare path in prose";
  if (source.includes(`](${link.raw})`) || source.includes(`](${encodeURI(link.raw)})`)) return "[label](path) link";
  if (source.includes(`\`${link.raw}\``)) return "`backtick path`";
  return "labelled chip";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = `audit-${Math.random().toString(36).slice(2)}`;
  const state = await mkdtemp(join(tmpdir(), "loom-audit-"));

  const server = Bun.spawn(["bun", "server/main.ts"], {
    cwd: LOOM,
    env: {
      ...process.env,
      LOOM_PORT: String(args.port),
      LOOM_TOKEN: token,
      LOOM_STATE: join(state, "state"),
      LOOM_PROJECTS_ROOT: args.root,
      // Only when asked. Otherwise the server's own `defaultRoots` applies, which is the thing being
      // measured — and INHERITING one is the trap: this shell exports `LOOM_ROOTS`, so two runs of
      // the audit silently measured two different guards and the second reported 200 more failures
      // than the first for no reason in the code (found 2026-08-24, re-running the audit after the
      // fixes). An override has to be asked for, never absorbed.
      LOOM_ROOTS: args.roots,
      LOOM_ALIASES: "/home/user/docs=/home/user/resilio/docs",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let browser: Browser | null = null;
  try {
    await waitForServer(server, args.port, token, 180000);
    const records = await loadRecords(args.port, token);
    const recordPaths = new Set(records.map((r) => r.path.replace(/\/+$/u, "")));
    const recordItems = new Map<string, number[]>();

    const bundle = await Bun.build({
      entrypoints: [join(HERE, "render-entry.ts")],
      target: "browser",
      format: "iife",
      minify: false,
    });
    if (!bundle.success) throw new Error(`could not bundle the renderer: ${bundle.logs.join("\n")}`);
    const script = await (bundle.outputs[0]?.text() ?? Promise.resolve(""));
    if (script.length === 0) throw new Error("the renderer bundle came out empty");

    browser = await chromium.launch({
      ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}),
      args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=256", "--renderer-process-limit=2", "--no-zygote"],
    });
    const context = await browser.newContext();
    await context.addCookies([
      { name: "loom_token", value: token, domain: "127.0.0.1", path: "/" },
      { name: `loom_token_${args.port}`, value: token, domain: "127.0.0.1", path: "/" },
    ]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${args.port}/`, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: script });

    const judged: Judged[] = [];
    const seen = new Map<string, ServerAnswer>();
    let links = 0;
    let rendered = 0;
    let stopped = false;

    const stats: HarvestStats = await harvest(args.root, async (posted: Posted[]) => {
      if (stopped) return false;
      for (let at = 0; at < posted.length; at += 100) {
        if (stopped) return false;
        const batch = posted.slice(at, at + 100);
        const found = (await page.evaluate(
          ([texts, recs, cwd]) => window.__audit.render(texts as string[], recs as never, cwd as string | null),
          [batch.map((p) => p.text), records, batch[0]?.cwd ?? null] as const,
        )) as FoundLink[][];
        rendered += batch.length;
        if (!args.quiet) {
          process.stderr.write(
            `\r  ${rendered} messages · ${links} links · ${judged.length} failures · ${message0(batch)}   `,
          );
        }

        for (let i = 0; i < batch.length; i += 1) {
          const message = batch[i];
          const list = found[i];
          if (message === undefined || list === undefined) continue;
          for (const link of list) {
            links += 1;
            // An anchor is judged on its own terms: a link that leaves loom must open a new tab,
            // and a path-shaped anchor that no chip pass claimed is a link that does nothing.
            if (link.anchor !== null) {
              const external = /^(?:https?|mailto):/i.test(link.anchor.href);
              if (external && link.anchor.target !== "_blank") {
                judged.push({
                  cause: "external-no-new-tab",
                  says: "a link out of loom that navigates this tab away instead of opening a new one",
                  raw: link.raw, path: link.path, place: null, label: link.label,
                  form: formOf(message.text, link), session: message.session, when: message.when,
                });
              }
              continue;
            }

            const isRecord = recordPaths.has(link.path.replace(/\/+$/u, ""));
            let items: number[] | null = null;
            if (isRecord && link.place !== null) {
              if (!recordItems.has(link.path)) {
                const body = await Bun.file(link.path).text().catch(() => "");
                recordItems.set(link.path, itemsOf(body));
              }
              items = recordItems.get(link.path) ?? null;
            }

            const facts: ChipFacts = {
              raw: link.raw, path: link.path, place: link.place, label: link.label,
              fixed: link.fixed, wiki: link.wiki, isRecord, recordItems: items,
            };

            let answer: ServerAnswer | null = null;
            if (!(isRecord && (link.place === null || /^#\s*next\s+\d+\s*$/i.test(link.place)))) {
              // The envelope is read when the answer needs more than a status: a PLACE has to be
              // checked against the file, and an `.html` link has to know whether loom called the
              // file `text`, which is the whole of the opens-as-source bug.
              const needBody = link.place !== null || /\.html?$/i.test(link.path);
              // The client sends the record it has open as a second ladder (SPEC 245). For a link
              // posted in a session, that is the record the session belongs to.
              const owning = message.cwd === null ? null : enclosingRecord(message.cwd, records);
              const key = `${link.path} ${message.cwd ?? ""} ${owning?.path ?? ""} ${needBody ? 1 : 0}`;
              const cached = seen.get(key);
              answer =
                cached ??
                (await ask(args.port, token, link.path, message.cwd, needBody, owning?.path ?? null));
              if (cached === undefined) seen.set(key, answer);
            }

            const verdict = judge(facts, answer);
            if (verdict.cause === "ok") continue;
            judged.push({
              cause: verdict.cause, says: verdict.says,
              raw: link.raw, path: link.path, place: link.place, label: link.label,
              form: formOf(message.text, link), session: message.session, when: message.when,
            });
          }
        }
        if (args.limit > 0 && rendered >= args.limit) {
          stopped = true;
          return false;
        }
      }
    });

    if (!args.quiet) process.stderr.write("\n");
    const report = writeReport(stats, rendered, links, judged);
    await writeFile(args.out, report, "utf8");
    console.log(
      `sessions ${stats.sessions} · messages ${stats.messages} (rendered ${rendered}, skipped ${stats.skipped}) · ` +
        `links ${links} · failures ${judged.length} in ${new Set(judged.map((j) => `${j.cause}|${family(j.says)}`)).size} groups`,
    );
    console.log(args.out);
  } finally {
    await browser?.close();
    server.kill();
    await rm(state, { recursive: true, force: true });
  }
}

function writeReport(
  stats: HarvestStats,
  rendered: number,
  links: number,
  judged: readonly Judged[],
): string {
  const groups = new Map<string, Judged[]>();
  for (const one of judged) {
    const key = `${one.cause} ${family(one.says)}`;
    groups.set(key, [...(groups.get(key) ?? []), one]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const today = new Date().toISOString().slice(0, 10);

  const out: string[] = [
    "---",
    "type: report",
    `created: ${today}`,
    "---",
    "",
    "# Every link ever posted, replayed through loom",
    "",
    "Produced by `tools/loom/tests/audit/link-audit.ts`. Each message was rendered by loom's own",
    "`renderMarkdown` in a browser, and every chip it produced was put to loom's own server. What",
    "the chip does with the answer is the one modelled part — `tests/audit/verdict.ts`.",
    "",
    "## What it looked at",
    "",
    `- sessions read: **${stats.sessions}** across ${stats.projects} project directories`,
    `- messages the assistant posted: **${stats.messages}**`,
    `- of those, rendered: **${rendered}** (${stats.skipped} skipped for containing no \`/\` and no \`[[\`)`,
    `- transcripts that would not parse: ${stats.unreadable}`,
    `- links found: **${links}**`,
    `- links that do not do what they say: **${judged.length}**, in ${ordered.length} groups`,
    "",
  ];

  if (ordered.length === 0) {
    out.push("Nothing failed. Read the numbers above before believing that.", "");
    return out.join("\n");
  }

  out.push("## What is broken", "");
  let n = 0;
  for (const [, list] of ordered) {
    n += 1;
    const first = list[0];
    if (first === undefined) continue;
    const forms = new Map<string, number>();
    for (const one of list) forms.set(one.form, (forms.get(one.form) ?? 0) + 1);
    const reasons = new Map<string, number>();
    for (const one of list) reasons.set(one.says, (reasons.get(one.says) ?? 0) + 1);
    out.push(
      `### ${n}. ${list.length} × ${first.cause}`,
      "",
      `${family(first.says)}.`,
      "",
      `Written as: ${[...forms.entries()].sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f} (${c})`).join(", ")}.`,
      "",
      "Examples:",
      "",
    );
    for (const one of list.slice(0, 5)) {
      const place = one.place === null ? "" : ` → \`${one.place}\``;
      out.push(
        `- \`${one.path}\`${place} — said "${one.label.slice(0, 60)}", ${one.when.slice(0, 10)}` +
          (reasons.size > 1 ? ` · ${one.says}` : ""),
      );
    }
    out.push("");
  }
  return out.join("\n");
}

if (import.meta.main) {
  await main();
}
