/** Preprompt jobs: a cheap model gathers context in a child process while the session keeps running.
 *
 * This module is the supervisor and nothing else. It spawns the runner, watches the run directory
 * it writes, and turns what appears there into a stream of events. It does not render anything, it
 * does not decide what the runner should do, and it never restarts a round: a round that died is a
 * round the user can read the error of and start again by hand.
 *
 * The runner is the tool in the vault (`tools/preprompt/preprompt.ts`). It is not in this repository,
 * you cannot read it from here, and you cannot run it in this test suite - which is why the command
 * is configurable and the tests point it at a fake.
 *
 * Progress is derived by polling `run.json` and `artifact.md`, not by watching the filesystem. A
 * watcher would need a dependency and would still have to diff the file to know what changed, and
 * the runner writes every 5-30 seconds, so 400ms of latency is invisible and costs one stat.
 */

import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PrepromptState = "running" | "done" | "error";

/** One line of the event stream, as the browser receives it. */
export interface PrepromptEvent {
  event: "step" | "command" | "note" | "artifact-updated" | "done" | "error";
  data: Record<string, unknown>;
}

export interface PrepromptJob {
  jobId: string;
  slug: string;
  /** The question, kept so a page that reloads can redraw the package it belongs to. */
  prompt: string;
  sessionId: string;
  runDir: string;
  state: PrepromptState;
  /** Every event this job has produced, oldest first. A late reader gets all of them. */
  history: PrepromptEvent[];
  /** Open streams. A job with no readers keeps running: the run directory is the product. */
  readers: Set<(event: PrepromptEvent) => void>;
  accepted: boolean;
  child: Child | null;
  /** The last of the runner's own progress output, kept for the error event. */
  stderr: () => string;
  poll: ReturnType<typeof setInterval> | null;
  /** How much of the run directory has already been turned into events. */
  seen: { commands: number; notes: number; step: number; artifactBytes: number };
}

export interface PrepromptOptions {
  /** argv prefix for the runner, e.g. ["bun", "/vault/tools/preprompt/preprompt.ts"]. */
  command: string[];
  /** Where the runner keeps its run directories: `<runs>/<slug>/run.json`. */
  runsDir: string;
  /** cwd for the child, and the root the runner reads. */
  root: string;
  /** Overridable so the tests do not wait 400ms per assertion. */
  pollMs?: number;
  spawn?: (argv: string[], cwd: string) => Child;
}

interface Child {
  kill(): void;
  exited: Promise<number>;
  /** The tail of what the child wrote to stderr, for when it dies and you need the reason. */
  stderr?: () => string;
}

const HEX = "0123456789abcdef";

function jobId(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out; // 12 hex characters, per the contract the client pattern-matches on
}

/** `pp-<first 8 of the session id>-<YYYYMMDD-HHMMSS>`: sortable, and it names its session.
 *  A gather that runs before any session exists - the normal case, since gathering is what you
 *  do BEFORE you ask - is named `pp-new-...` and belongs to nobody until it is accepted. */
export function slugFor(sessionId: string, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `pp-${sessionId === "" ? "new" : sessionId.slice(0, 8)}-${stamp}`;
}

export class Preprompt {
  private jobs = new Map<string, PrepromptJob>();
  private packages = new Map<string, { stamp: string; text: string }>();
  private readonly pollMs: number;

  constructor(private options: PrepromptOptions) {
    this.pollMs = options.pollMs ?? 400;
  }

  get(jobId: string): PrepromptJob | undefined {
    return this.jobs.get(jobId);
  }

  /** Every job this server knows about, including the ones that belong to no session yet. */
  all(): PrepromptJob[] {
    return [...this.jobs.values()];
  }

  /** Jobs for one session, oldest first. Many rounds of gathering per session is the normal case. */
  forSession(sessionId: string): PrepromptJob[] {
    return [...this.jobs.values()].filter((job) => job.sessionId === sessionId);
  }

  start(sessionId: string, prompt: string, roots: string[] = []): PrepromptJob {
    const slug = slugFor(sessionId);
    const job: PrepromptJob = {
      jobId: jobId(),
      slug,
      prompt,
      sessionId,
      runDir: join(this.options.runsDir, slug),
      state: "running",
      history: [],
      readers: new Set(),
      accepted: false,
      child: null,
      stderr: () => "",
      poll: null,
      seen: { commands: 0, notes: 0, step: 0, artifactBytes: 0 },
    };
    const argv = [...this.options.command, "new", prompt, "--slug", slug];
    for (const root of roots) argv.push("--root", root);
    job.child = this.spawn(argv);
    job.stderr = job.child.stderr ?? (() => "");
    this.jobs.set(job.jobId, job);
    this.watch(job);
    void job.child.exited.then((code) => this.finish(job, code));
    return job;
  }

  /** A second round on the same slug, appended to the same artifact. */
  gap(job: PrepromptJob, text: string): { ok: true } | { ok: false; reason: "busy" } {
    if (job.state === "running" && job.child !== null) return { ok: false, reason: "busy" };
    job.state = "running";
    job.child = this.spawn([...this.options.command, "gap", job.slug, text]);
    job.stderr = job.child.stderr ?? (() => "");
    this.watch(job);
    void job.child.exited.then((code) => this.finish(job, code));
    return { ok: true };
  }

  /** The artifact as it stands, for showing what has been gathered so far. */
  async artifact(job: PrepromptJob): Promise<string> {
    try {
      return await readFile(join(job.runDir, "artifact.md"), "utf8");
    } catch {
      return "";
    }
  }

  /** The paste-ready message, from the runner itself: this module never renders it.
   *
   *  Cached against the artifact's size and mtime. Without that, every `artifact-updated` event
   *  made every watching tab fetch the package, and every fetch spawned a fresh child process to
   *  render it - a process-spawning storm proportional to readers times writes. */
  async message(job: PrepromptJob): Promise<string> {
    const stamp = this.stamp(join(job.runDir, "artifact.md"));
    const hit = this.packages.get(job.jobId);
    if (hit !== undefined && hit.stamp === stamp) return hit.text;
    const text = await this.render(job);
    this.packages.set(job.jobId, { stamp, text });
    return text;
  }

  private stamp(path: string): string {
    try {
      const info = statSync(path);
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return "none";
    }
  }

  private async render(job: PrepromptJob): Promise<string> {
    const argv = [...this.options.command, "message", job.slug];
    const child = Bun.spawn(argv, { cwd: this.options.root, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(child.stdout).text();
    await child.exited;
    return text;
  }

  /** Killing a live round. The run directory stays: half a gather is still evidence. */
  kill(job: PrepromptJob): void {
    job.child?.kill();
    job.child = null;
    this.stopWatching(job);
    if (job.state === "running") this.emit(job, { event: "error", data: { message: "killed" } });
    job.state = "error";
    this.jobs.delete(job.jobId);
  }

  /** Every live child dies with the server. Jobs do not survive a restart and are not restored. */
  shutdown(): void {
    for (const job of this.jobs.values()) {
      job.child?.kill();
      this.stopWatching(job);
    }
    this.jobs.clear();
  }

  /** A reader gets the whole history first, then everything that follows, then the stream closes. */
  subscribe(job: PrepromptJob, send: (event: PrepromptEvent) => void): () => void {
    for (const event of job.history) send(event);
    if (job.state !== "running") return () => {};
    job.readers.add(send);
    return () => job.readers.delete(send);
  }

  private spawn(argv: string[]): Child {
    if (this.options.spawn) return this.options.spawn(argv, this.options.root);
    const child = Bun.spawn(argv, { cwd: this.options.root, stdout: "ignore", stderr: "pipe" });
    // Drain stderr. The runner reports its progress there, and a pipe nobody reads fills and
    // stops the child dead - which looks exactly like a slow gather, from the outside. Measured
    // 2026-09-17: a job sat "gathering" for two minutes having written nothing at all.
    let tail = "";
    void (async () => {
      const decoder = new TextDecoder();
      const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value !== undefined) tail = (tail + decoder.decode(chunk.value)).slice(-4000);
      }
    })();
    return { kill: () => child.kill(), exited: child.exited, stderr: () => tail };
  }

  private watch(job: PrepromptJob): void {
    if (job.poll !== null) return;
    job.poll = setInterval(() => void this.sweep(job), this.pollMs);
  }

  private stopWatching(job: PrepromptJob): void {
    if (job.poll !== null) clearInterval(job.poll);
    job.poll = null;
  }

  /** One pass over the run directory: everything new becomes an event, in the order it happened. */
  private async sweep(job: PrepromptJob): Promise<void> {
    const run = await this.readRun(job);
    if (run !== null) {
      const header = (run["header"] ?? {}) as Record<string, unknown>;
      const evidence = (run["evidence"] ?? []) as Record<string, unknown>[];
      const notes = (run["notes"] ?? []) as unknown[];

      for (const entry of evidence.slice(job.seen.commands)) {
        // The output is the point: a log of command names tells you a model was busy, not what
        // it found. Duration is deliberately absent - it was dropped in the design conversation.
        const refused = String(entry["refused"] ?? "");
        this.emit(job, {
          event: "command",
          data: {
            n: entry["n"] ?? job.seen.commands + 1,
            command: entry["command"] ?? "",
            at: entry["at"] ?? "",
            exitCode: entry["exitCode"] ?? null,
            refused,
            output: refused.length > 0 ? "" : String(entry["stdout"] ?? ""),
            stderr: String(entry["stderr"] ?? ""),
          },
        });
      }
      job.seen.commands = evidence.length;

      for (const note of notes.slice(job.seen.notes)) {
        // A note is `{ round, text }` in run.json. Stringifying it gave "[object Object]" in the
        // panel, which is how the model's own reading reached the user as nothing at all.
        const text =
          typeof note === "string"
            ? note
            : String((note as Record<string, unknown>)["text"] ?? JSON.stringify(note));
        this.emit(job, { event: "note", data: { text } });
      }
      job.seen.notes = notes.length;

      const step = Number(header["steps"] ?? evidence.length);
      if (step !== job.seen.step) {
        job.seen.step = step;
        this.emit(job, {
          event: "step",
          data: {
            step,
            model: header["modelUsed"] ?? header["model"] ?? null,
            promptTokens: header["promptTokens"] ?? 0,
            completionTokens: header["completionTokens"] ?? 0,
          },
        });
      }
    }

    const bytes = this.size(join(job.runDir, "artifact.md"));
    if (bytes !== job.seen.artifactBytes) {
      job.seen.artifactBytes = bytes;
      this.emit(job, { event: "artifact-updated", data: { bytes } });
    }
  }

  /** The child is gone. One last sweep, so the last stage it wrote is not lost to the race. */
  /** How long a finished job stays in memory with its history. Long enough to reload the page
   *  and decide; not so long that a day of gathering is still resident at midnight. */
  private static readonly KEEP_FINISHED_MS = 30 * 60 * 1000;

  private forget(job: PrepromptJob): void {
    setTimeout(() => {
      this.jobs.delete(job.jobId);
      this.packages.delete(job.jobId);
    }, Preprompt.KEEP_FINISHED_MS).unref?.();
  }

  private async finish(job: PrepromptJob, code: number): Promise<void> {
    if (!this.jobs.has(job.jobId)) return; // killed; its error event is already out
    await this.sweep(job);
    this.stopWatching(job);
    job.child = null;
    const run = await this.readRun(job);
    const header = (run?.["header"] ?? {}) as Record<string, unknown>;
    if (code === 0) {
      job.state = "done";
      this.emit(job, { event: "done", data: { stopReason: header["stopReason"] ?? "finished" } });
    } else {
      job.state = "error";
      const said = job.stderr().trim().split("\n").slice(-3).join(" · ");
      this.emit(job, {
        event: "error",
        data: { message: said.length > 0 ? `runner exited ${code}: ${said}` : `runner exited ${code}` },
      });
    }
    for (const reader of job.readers) job.readers.delete(reader);
    this.forget(job);
  }

  private async readRun(job: PrepromptJob): Promise<Record<string, unknown> | null> {
    try {
      // A partially written run.json is normal: the runner rewrites it between stages, and a
      // reader that lands mid-write must wait rather than report the run as broken.
      return JSON.parse(await readFile(join(job.runDir, "run.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private size(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private emit(job: PrepromptJob, event: PrepromptEvent): void {
    job.history.push(event);
    for (const reader of job.readers) reader(event);
  }
}
