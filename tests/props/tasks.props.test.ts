/**
 * The task surface's contract (SPEC §Tasks). loom writes into project records, so the properties
 * here are about what a write may NOT do: the load-bearing one is CONFINEMENT — every byte outside
 * the edited item's own line span survives a write unchanged. A regex-driven editor loose in the
 * vault is the failure this whole file exists to make impossible to ship quietly.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  addTask,
  parseRecord,
  promoteTask,
  setResult,
  setStatus,
  setStanding,
  setSubproject,
  setTitle,
  slugify,
  writeAtomic,
  STANDINGS,
  STATUSES,
  type TaskStatus,
} from "../../server/tasks.ts";

/** A real record, in the shape the `project` skill writes — the shape the parser must survive. */
const REAL = `---
type: project
status: active
created: 2026-08-05
parent: ../../project.md
---

# UI iteration — small needs

## Frame

**Need.** The stream of concrete UI needs from daily driving.

## Next

1. [x] **Right panel un-hidable** — need: collapsing artifacts must be reversible.
   result: collapse leaves a slim reopen handle. — 2026-08-05
   artifacts: client/style.css · client/app.ts
2. [ ] **Composer height** — need: two lines is too small.
3. [/] **Who wrote what** — need: user vs assistant visibly different.
4. **A plain prose item**, no box, left alone by loom.
5. [>] **Grew too big** — need: this one graduated.
   subproject: too-big/project.md

## Log

- 2026-08-05 — the round happened.
`;

describe("parseRecord over a real record", () => {
  const doc = parseRecord(REAL);

  test("the Next section becomes tasks; the prose around it is handed back whole", () => {
    expect(doc.tasks).toHaveLength(5);
    expect(doc.head).toContain("**Need.** The stream");
    expect(doc.head.trimEnd().endsWith("## Next")).toBe(true);
    expect(doc.tail).toContain("## Log");
    expect(doc.tail).not.toContain("Composer height");
  });

  test("status boxes map to the vocabulary; a boxless item is prose, not a guess", () => {
    expect(doc.tasks.map((t) => t.status)).toEqual(["done", "open", "doing", null, "promoted"]);
  });

  test("fields come off the line whether inline or on a continuation", () => {
    const first = doc.tasks[0];
    expect(first?.title).toBe("Right panel un-hidable");
    expect(first?.need).toBe("collapsing artifacts must be reversible.");
    expect(first?.result).toBe("collapse leaves a slim reopen handle. — 2026-08-05");
    expect(first?.artifacts).toEqual(["client/style.css", "client/app.ts"]);
    expect(doc.tasks[4]?.subproject).toBe("too-big/project.md");
  });

  test("a record with no Next section is not an error", () => {
    const doc2 = parseRecord("---\ntype: project\n---\n\n# X\n\nJust prose.\n");
    expect(doc2.tasks).toEqual([]);
    expect(doc2.head).toContain("Just prose.");
    expect(doc2.tail).toBe("");
  });
});

/**
 * A record with a hand-wrapped title — this shape is what `project` actually writes (a name plus
 * dash-plan running past 80 columns wraps to the margin like any other sentence). Field-found
 * 2026-08-07: User read the tree and said the tasks "have their ends cut, they don't read like
 * finished sentences" — `titleOf` was reading only an item's first line, so a name that wrapped
 * before its first field label lost everything past the wrap.
 */
const WRAPPED = `---
type: project
status: active
---

# A record

## Next

1. [ ] **Give the attention facts an end-of-turn timestamp** — decide whether it comes from the
   transcript's own rows or from the job frame, then report it beside \`lastReply\`.
2. [ ] **Mark on that timestamp instead of the newest reply** — the client draws the letter only
   when the turn that produced it has finished.
   need: a long need clause that itself
   runs onto its own continuation line, past the wrapped title above it.
`;

describe("parseRecord over a hand-wrapped record", () => {
  test("a title that wraps onto a continuation line reads as the whole sentence, not cut at the wrap", () => {
    const doc = parseRecord(WRAPPED);
    expect(doc.tasks[0]?.title).toBe(
      "Give the attention facts an end-of-turn timestamp — decide whether it comes from the transcript's own rows or from the job frame, then report it beside `lastReply`.",
    );
    expect(doc.tasks[1]?.title).toBe(
      "Mark on that timestamp instead of the newest reply — the client draws the letter only when the turn that produced it has finished.",
    );
  });

  test("a wrapped title does not swallow a field clause sitting on its own continuation line", () => {
    const doc = parseRecord(WRAPPED);
    expect(doc.tasks[1]?.need).toBe(
      "a long need clause that itself\nruns onto its own continuation line, past the wrapped title above it.",
    );
  });

  test("retitling a wrapped item replaces every line the old name occupied, not just the first", () => {
    const out = setTitle(WRAPPED, 1, "A short new name");
    expect(out).toContain("1. [ ] **A short new name**");
    expect(out).not.toContain("transcript's own rows");
    const doc = parseRecord(out);
    expect(doc.tasks[0]?.title).toBe("A short new name");
    // The item after it is untouched.
    expect(doc.tasks[1]?.title).toContain("Mark on that timestamp");
  });
});

/** The same shape with the optional `## Hypotheses` section, between Frame and Where it stands. */
const REAL_H = `---
type: project
status: active
created: 2026-08-06
---

# Projects in loom

## Frame

**Need.** Projects as real objects.

## Hypotheses

1. **One recursive shape for tasks and projects.** *Open*: a task carries a status and a result, so
   the claim holds or visibly fails under daily ticking.
2. **A result can be derived from what the sessions touched.** *Half-supported 2026-08-05*: a done
   task's artifacts are picked from real touches.
3. **Open records load faster than closed ones.** — a claim nobody gave a standing.

## Where it stands

Shipped and driven.

## Next

1. [ ] **Derive a project's sessions** — v1: sessions whose cwd is the project's directory.

## Log

- 2026-08-06 — the round happened.
`;

describe("parseRecord over a record with hypotheses", () => {
  const doc = parseRecord(REAL_H);

  test("the claims come out numbered, and the prose around them is handed back whole", () => {
    expect(doc.hypotheses.map((h) => h.n)).toEqual([1, 2, 3]);
    expect(doc.head.trimEnd().endsWith("## Hypotheses")).toBe(true);
    expect(doc.head).toContain("**Need.** Projects as real objects.");
    expect(doc.middle).toContain("## Where it stands");
    expect(doc.middle.trimEnd().endsWith("## Next")).toBe(true);
    expect(doc.tasks).toHaveLength(1);
    expect(doc.tail).toContain("## Log");
  });

  test("standing and its date come off the italic marker; the claim keeps its own words", () => {
    expect(doc.hypotheses[0]?.standing).toBe("open");
    expect(doc.hypotheses[0]?.since).toBeNull();
    expect(doc.hypotheses[0]?.claim).toBe("One recursive shape for tasks and projects.");
    expect(doc.hypotheses[0]?.evidence).toBe(
      "a task carries a status and a result, so the claim holds or visibly fails under daily ticking.",
    );
    expect(doc.hypotheses[1]?.standing).toBe("half-supported");
    expect(doc.hypotheses[1]?.since).toBe("2026-08-05");
  });

  test("a claim with no standing is still a claim — loom renders it and never guesses one", () => {
    expect(doc.hypotheses[2]?.standing).toBeNull();
    expect(doc.hypotheses[2]?.claim).toBe("Open records load faster than closed ones.");
    expect(doc.hypotheses[2]?.evidence).toBe("— a claim nobody gave a standing.");
  });

  test("a record with no Hypotheses section parses exactly as it did before", () => {
    const plain = parseRecord(REAL);
    expect(plain.hypotheses).toEqual([]);
    expect(plain.middle).toBe("");
    expect(plain.head.trimEnd().endsWith("## Next")).toBe(true);
  });

  test("`## Hypotheses` below `## Next` is left in the prose, not reordered under the reader", () => {
    const out = parseRecord(`# X\n\n## Next\n\n1. [ ] **A task**\n\n## Hypotheses\n\n1. **A claim.** *Open*: yes.\n`);
    expect(out.hypotheses).toEqual([]);
    expect(out.tasks).toHaveLength(1);
    expect(out.tail).toContain("## Hypotheses");
  });
});

describe("writes", () => {
  test("ticking a status rewrites the box and nothing else on the line", () => {
    const out = setStatus(REAL, 2, "done");
    expect(out).toContain("2. [x] **Composer height** — need: two lines is too small.");
    expect(parseRecord(out).tasks[1]?.status).toBe("done");
  });

  test("a prose item can be given a box without losing its text", () => {
    const out = setStatus(REAL, 4, "open");
    expect(out).toContain("4. [ ] **A plain prose item**, no box, left alone by loom.");
  });

  test("a result replaces the previous one instead of accreting", () => {
    const once = setResult(REAL, 1, "first outcome", ["a.ts"], "2026-08-06");
    const twice = setResult(once, 1, "second outcome", ["b.ts"], "2026-08-06");
    expect(twice).not.toContain("first outcome");
    expect(twice).not.toContain("a.ts");
    expect(parseRecord(twice).tasks[0]?.result).toBe("second outcome — 2026-08-06");
    expect(parseRecord(twice).tasks[0]?.artifacts).toEqual(["b.ts"]);
  });

  test("an inline result is lifted to its own line, and its neighbours on that line survive", () => {
    const out = setResult(REAL, 1, "moved out", [], "2026-08-06");
    expect(out).toContain("1. [x] **Right panel un-hidable** — need: collapsing artifacts must be reversible.");
    expect(out).toContain("   result: moved out — 2026-08-06");
    expect(parseRecord(out).tasks[0]?.need).toBe("collapsing artifacts must be reversible.");
  });

  test("a multi-line result is written as one line — nothing loom writes can wrap", () => {
    const out = setResult(REAL, 2, "line one\nline two\n\nline three", [], null);
    expect(out).toContain("   result: line one line two line three");
    expect(parseRecord(out).tasks).toHaveLength(5);
  });

  test("editing a task that does not exist is refused, not guessed at", () => {
    expect(() => setStatus(REAL, 99, "done")).toThrow();
  });
});

// ── generated records ─────────────────────────────────────────────────

const TITLE = fc.stringMatching(/^[A-Za-zА-Яа-я0-9 ,.()—-]{1,40}$/);

/** Prose that carries no field label, so a round-trip means what it says (SPEC §Tasks 53). */
const PROSE = fc
  .stringMatching(/^[^\n]{0,80}$/)
  .filter((s) => !/\b(need|hypo|result|artifacts|subproject):/.test(s));

const item = fc
  .record({
    marker: fc.constantFrom("1.", "-", "*"),
    box: fc.constantFrom(" ", "x", "/", "-", ">", null),
    title: TITLE,
    need: fc.option(PROSE, { nil: null }),
    extra: fc.array(PROSE, { maxLength: 2 }),
    gap: fc.boolean(),
  })
  .map((spec) => {
    const box = spec.box === null ? "" : `[${spec.box}] `;
    const need = spec.need === null ? "" : ` — need: ${spec.need}`;
    const lines = [`${spec.marker} ${box}**${spec.title}**${need}`];
    for (const line of spec.extra) lines.push(`   ${line}`);
    if (spec.gap) lines.push("");
    return lines.join("\n");
  });

const claim = fc
  .record({
    marker: fc.constantFrom("1.", "-", "*"),
    title: TITLE,
    standing: fc.option(fc.constantFrom(...STANDINGS), { nil: null }),
    since: fc.option(fc.constantFrom("2026-08-05", "2026-01-31"), { nil: null }),
    evidence: PROSE,
    extra: fc.array(PROSE, { maxLength: 2 }),
    gap: fc.boolean(),
  })
  .map((spec) => {
    const date = spec.since === null ? "" : ` ${spec.since}`;
    const mark = spec.standing === null ? "" : ` *${spec.standing}${date}*: ${spec.evidence}`;
    const lines = [`${spec.marker} **${spec.title}**${mark}`];
    for (const line of spec.extra) lines.push(`   ${line}`);
    if (spec.gap) lines.push("");
    return lines.join("\n");
  });

const record = fc
  .record({
    front: fc.constantFrom("---\ntype: project\nstatus: active\n---\n", ""),
    before: fc.array(PROSE, { maxLength: 3 }),
    hypos: fc.option(fc.array(claim, { minLength: 1, maxLength: 4 }), { nil: null }),
    between: fc.array(PROSE, { maxLength: 3 }),
    heading: fc.constantFrom("## Next", "### Next", "## next"),
    items: fc.array(item, { minLength: 1, maxLength: 5 }),
    after: fc.option(fc.array(PROSE, { maxLength: 3 }), { nil: null }),
  })
  .map((spec) => {
    const parts = [spec.front, "# A record", "", ...spec.before, ""];
    // Half the generated records carry the optional section, so every task property below is also
    // stated over a record where `## Next` is no longer the first section loom operates.
    if (spec.hypos !== null) {
      parts.push("## Hypotheses", "", spec.hypos.join("\n"), "", "## Where it stands", "", ...spec.between, "");
    }
    parts.push(spec.heading, "");
    parts.push(spec.items.join("\n"));
    if (spec.after !== null) parts.push("", "## Log", "", ...spec.after);
    return parts.join("\n");
  });

/** Byte-identical outside the edited span — stated as head/tail line slices, not as a vibe. */
function confined(before: string, after: string, from: number, to: number): void {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.slice(0, from)).toEqual(a.slice(0, from));
  expect(b.slice(b.length - (a.length - to))).toEqual(a.slice(to));
}

/**
 * CONFINEMENT restated for the writes that CREATE lines (SPEC 72).
 *
 * A write that adds a line falsifies the per-item property by construction — the tail shifts — so
 * the region becomes the SECTION: every line before its heading, and every line after its last
 * item, comes back byte-identical. Strictly weaker than the per-item one, which is exactly why it
 * is written down rather than assumed.
 */
function confinedToSection(before: string, after: string, heading: RegExp): void {
  const a = before.split("\n");
  const b = after.split("\n");
  const at = a.findIndex((line) => heading.test(line));
  expect(at).toBeGreaterThanOrEqual(0);
  expect(b.slice(0, at + 1)).toEqual(a.slice(0, at + 1));

  // The section's end is the next heading; everything from there on must survive untouched.
  let end = a.length;
  for (let i = at + 1; i < a.length; i += 1) {
    if (/^#{1,6}\s/.test(a[i] ?? "")) {
      end = i;
      break;
    }
  }
  expect(b.slice(b.length - (a.length - end))).toEqual(a.slice(end));
}

const NEXT = /^#{2,3}\s+Next\s*$/i;

/** Same frontmatter rule the parser uses — the body is what a reader sees. */
function bodyStartOf(lines: readonly string[]): number {
  if (lines[0] !== "---") return 0;
  const end = lines.indexOf("---", 1);
  return end < 0 ? 0 : end + 1;
}

describe("properties", () => {
  test("total: arbitrary text never throws and never yields an empty or inverted span", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const doc = parseRecord(text);
        for (const part of [...doc.hypotheses, ...doc.tasks]) {
          expect(part.to).toBeGreaterThan(part.from);
          expect(part.n).toBeGreaterThan(0);
        }
      }),
    );
  });

  // Extracting the claims out of `head` is a read-path change, and the way it goes wrong is silent:
  // a section that stops rendering looks like a record that never had one.
  test("the split loses nothing — every non-blank body line lands in exactly one part", () => {
    fc.assert(
      fc.property(record, (text) => {
        const doc = parseRecord(text);
        const lines = text.split("\n");
        const spans = [...doc.hypotheses, ...doc.tasks].map((p) => lines.slice(p.from, p.to).join("\n"));
        const kept = new Set([doc.head, doc.middle, doc.tail, ...spans].join("\n").split("\n"));
        for (const line of lines.slice(bodyStartOf(lines))) {
          if (line.trim().length === 0) continue;
          expect(kept.has(line)).toBe(true);
        }
      }),
    );
  });

  test("the parts are in file order and never overlap — a write addresses one item, not two", () => {
    fc.assert(
      fc.property(record, (text) => {
        const spans = [...parseRecord(text).hypotheses, ...parseRecord(text).tasks];
        for (let i = 1; i < spans.length; i += 1) {
          const previous = spans[i - 1];
          const current = spans[i];
          if (previous === undefined || current === undefined) continue;
          // Numbering restarts at the section boundary; ordering does not.
          expect(current.from).toBeGreaterThanOrEqual(previous.to);
        }
      }),
    );
  });

  test("a standing round-trips, and a claim opening with a standing word keeps it as its claim", () => {
    fc.assert(
      fc.property(record, (text) => {
        for (const hypothesis of parseRecord(text).hypotheses) {
          if (hypothesis.standing === null) continue;
          expect(STANDINGS).toContain(hypothesis.standing);
        }
      }),
    );
    const tricky = parseRecord("# X\n\n## Hypotheses\n\n1. **Open beats closed.** *Refuted 2026-08-06*: no.\n");
    expect(tricky.hypotheses[0]?.claim).toBe("Open beats closed.");
    expect(tricky.hypotheses[0]?.standing).toBe("refuted");
  });

  test("CONFINEMENT: a status write touches no line outside the task's own span", () => {
    fc.assert(
      fc.property(record, fc.integer({ min: 0, max: 4 }), fc.constantFrom(...STATUSES), (text, pick, status) => {
        const tasks = parseRecord(text).tasks;
        const task = tasks[pick % tasks.length];
        if (task === undefined) return;
        confined(text, setStatus(text, task.n, status as TaskStatus), task.from, task.to);
      }),
    );
  });

  test("CONFINEMENT: a result write touches no line outside the task's own span", () => {
    fc.assert(
      fc.property(record, fc.integer({ min: 0, max: 4 }), PROSE, fc.array(PROSE, { maxLength: 3 }), (text, pick, body, arts) => {
        const tasks = parseRecord(text).tasks;
        const task = tasks[pick % tasks.length];
        if (task === undefined) return;
        confined(text, setResult(text, task.n, body, arts, "2026-08-06"), task.from, task.to);
      }),
    );
  });

  test("a write never changes how many tasks the record has", () => {
    fc.assert(
      fc.property(record, fc.integer({ min: 0, max: 4 }), fc.constantFrom(...STATUSES), PROSE, (text, pick, status, body) => {
        const tasks = parseRecord(text).tasks;
        const task = tasks[pick % tasks.length];
        if (task === undefined) return;
        expect(parseRecord(setStatus(text, task.n, status as TaskStatus)).tasks).toHaveLength(tasks.length);
        expect(parseRecord(setResult(text, task.n, body, [], null)).tasks).toHaveLength(tasks.length);
        expect(parseRecord(setSubproject(text, task.n, "child/project.md")).tasks).toHaveLength(tasks.length);
      }),
    );
  });

  test("a status written is the status parsed back, for every status", () => {
    fc.assert(
      fc.property(record, fc.integer({ min: 0, max: 4 }), fc.constantFrom(...STATUSES), (text, pick, status) => {
        const tasks = parseRecord(text).tasks;
        const task = tasks[pick % tasks.length];
        if (task === undefined) return;
        const out = parseRecord(setStatus(text, task.n, status as TaskStatus)).tasks[task.n - 1];
        expect(out?.status).toBe(status as TaskStatus);
      }),
    );
  });

  test("a status write is idempotent — the second click changes no byte", () => {
    fc.assert(
      fc.property(record, fc.integer({ min: 0, max: 4 }), fc.constantFrom(...STATUSES), (text, pick, status) => {
        const tasks = parseRecord(text).tasks;
        const task = tasks[pick % tasks.length];
        if (task === undefined) return;
        const once = setStatus(text, task.n, status as TaskStatus);
        expect(setStatus(once, task.n, status as TaskStatus)).toBe(once);
      }),
    );
  });

  test("a result written is the result parsed back, and a second write does not accrete", () => {
    fc.assert(
      fc.property(record, fc.integer({ min: 0, max: 4 }), PROSE, PROSE, (text, pick, first, second) => {
        const tasks = parseRecord(text).tasks;
        const task = tasks[pick % tasks.length];
        if (task === undefined) return;
        const once = setResult(text, task.n, first, [], null);
        const twice = setResult(once, task.n, second, [], null);
        const back = parseRecord(twice).tasks[task.n - 1];
        const expected = second.replace(/\s+/g, " ").trim();
        // No artifacts and no date, so the result is the LAST clause on the line — and a last
        // clause keeps a trailing dash, because nothing follows for that dash to have introduced
        // (keyClauses, server/tasks.ts). Stripping it here unconditionally is what made this
        // property fail on seed 1540282507 with the result "! -", and the tempting fix was to make
        // the writer lossy so the two agreed. The writer is right; this expectation was wrong.
        if (expected.length === 0) expect(back?.result).toBeNull();
        else expect(back?.result).toBe(expected);
      }),
    );
  });

  test("artifact paths survive the round trip in order", () => {
    fc.assert(
      fc.property(
        record,
        fc.array(fc.stringMatching(/^[A-Za-z0-9_./-]{1,20}$/), { minLength: 1, maxLength: 4 }),
        (text, paths) => {
          const task = parseRecord(text).tasks[0];
          if (task === undefined) return;
          const out = parseRecord(setResult(text, task.n, "some outcome", paths, null)).tasks[0];
          expect(out?.artifacts).toEqual(paths);
        },
      ),
    );
  });

  // ── the writes that CREATE and RETITLE (SPEC 72–73) ─────────────────

  test("CONFINEMENT: adding a task touches nothing outside `## Next`, and adds exactly one", () => {
    fc.assert(
      fc.property(record, TITLE, (text, title) => {
        if (title.trim().length === 0) return;
        const before = parseRecord(text).tasks.length;
        const out = addTask(text, title);
        confinedToSection(text, out, NEXT);
        const doc = parseRecord(out);
        expect(doc.tasks).toHaveLength(before + 1);
        expect(doc.tasks[before]?.status).toBe("open");
        // The claims above it are untouched, which the section confinement alone would not say.
        expect(doc.hypotheses).toEqual(parseRecord(text).hypotheses);
      }),
    );
  });

  test("the separator he typed is the one written back", () => {
    // The shrunk counterexample from the seed that failed one run in sixteen, 2026-08-10: a hyphen
    // was rewritten as an em dash, so the name read back was a string nobody had typed.
    const text = "---\ntype: project\nstatus: active\n---\n\n# A record\n\n\n## Next\n\n1. [ ] **a**\n";
    for (const typed of ["0 - -—", "— - а", "one - two", "— - -"]) {
      const doc = parseRecord(addTask(text, typed));
      const added = doc.tasks[doc.tasks.length - 1];
      expect(typed).toContain(added?.title ?? "\u0000");
    }
  });

  test("EXPLICIT: result text '! -' with trailing dash roundtrips", () => {
    const text = "---\ntype: project\nstatus: active\n---\n\n# A record\n\n\n## Next\n\n1. [ ] **a**\n";
    const res = setResult(text, 1, "! -", ["foo"], null);
    const doc = parseRecord(res);
    expect(doc.tasks[0]?.result).toBe("! -");
  });

  test("an added name survives being read back, and survives being written again", () => {
    fc.assert(
      fc.property(record, TITLE, (text, title) => {
        const body = title.replace(/\s+/g, " ").trim();
        if (body.length === 0) return;
        const once = parseRecord(addTask(text, title));
        const added = once.tasks[once.tasks.length - 1];
        expect(added?.result).toBeNull();
        expect(added?.status).toBe("open");
        // The name loom wrote reads back as part of what was typed — never as bold markers, and
        // never as nothing.
        expect(added?.title.length).toBeGreaterThan(0);
        expect(added?.title).not.toContain("**");
        expect(body).toContain(added?.title ?? "\u0000");
        // And it is STABLE: typing back what the row shows must not shave the name again. Without
        // this, a name ending in a dash was written bolded and read back shorter than it was typed.
        const twice = parseRecord(addTask(text, added?.title ?? ""));
        expect(twice.tasks[twice.tasks.length - 1]?.title).toBe(added?.title);
      }),
    );
  });

  test("CONFINEMENT: a retitle touches no line outside the task's own span, and keeps its fields", () => {
    fc.assert(
      fc.property(record, fc.integer({ min: 0, max: 4 }), TITLE, (text, pick, title) => {
        if (title.trim().length === 0) return;
        const tasks = parseRecord(text).tasks;
        const task = tasks[pick % tasks.length];
        if (task === undefined) return;
        const out = setTitle(text, task.n, title);
        confined(text, out, task.from, task.to);
        const back = parseRecord(out).tasks[task.n - 1];
        // The name is the only thing that moved. Everything the item earned is still on it.
        expect(back?.status).toBe(task.status);
        expect(back?.result).toBe(task.result);
        expect(back?.artifacts).toEqual(task.artifacts);
        expect(back?.subproject).toBe(task.subproject);
      }),
    );
  });

  test("CONFINEMENT: a standing write touches no line outside its claim, and keeps the wording", () => {
    fc.assert(
      fc.property(
        record,
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom(...STANDINGS),
        (text, pick, standing) => {
          const claims = parseRecord(text).hypotheses;
          if (claims.length === 0) return;
          const target = claims[pick % claims.length];
          if (target === undefined) return;
          const out = setStanding(text, target.n, standing, "2026-08-06");
          confined(text, out, target.from, target.to);
          const back = parseRecord(out).hypotheses[target.n - 1];
          expect(back?.standing).toBe(standing);
          expect(back?.claim).toBe(target.claim);
          expect(back?.evidence).toBe(target.evidence);
          // No task moved, and the tasks below did not renumber.
          expect(parseRecord(out).tasks).toEqual(parseRecord(text).tasks);
        },
      ),
    );
  });

  test("restating a standing twice does not accrete markers", () => {
    fc.assert(
      fc.property(record, fc.constantFrom(...STANDINGS), (text, standing) => {
        const claims = parseRecord(text).hypotheses;
        if (claims.length === 0) return;
        const once = setStanding(text, 1, standing, "2026-08-06");
        const twice = setStanding(once, 1, standing, "2026-08-06");
        expect(twice).toBe(once);
      }),
    );
  });
});

describe("adding and retitling, on a real record", () => {
  test("a task is appended in the section's own numbering, with the name bolded at the dash", () => {
    const out = addTask(REAL, "Reorder by drag — renumber in one write");
    expect(out).toContain("6. [ ] **Reorder by drag** — renumber in one write");
    expect(out).toContain("## Log");
    expect(parseRecord(out).tasks).toHaveLength(6);
  });

  test("a record with no `## Next` is refused — loom does not invent sections in the vault", () => {
    expect(() => addTask("---\ntype: project\n---\n\n# X\n\nJust prose.\n", "A task")).toThrow();
    expect(() => addTask(REAL, "   ")).toThrow();
  });

  test("a retitle keeps the box, the result and the artifacts that came with it", () => {
    const out = setTitle(REAL, 1, "Right panel keeps a handle");
    expect(out).toContain("1. [x] **Right panel keeps a handle** — need: collapsing artifacts must be reversible.");
    expect(out).toContain("   result: collapse leaves a slim reopen handle. — 2026-08-05");
    expect(out).toContain("   artifacts: client/style.css · client/app.ts");
  });

  test("a standing is stamped in place, and a claim with none gets one after its name", () => {
    const out = setStanding(REAL_H, 2, "refuted", "2026-08-06");
    expect(out).toContain("*Refuted 2026-08-06*: a done");
    expect(out).not.toContain("Half-supported");
    const given = setStanding(REAL_H, 3, "supported", "2026-08-06");
    expect(given).toContain("**Open records load faster than closed ones.** *Supported 2026-08-06*: a claim nobody gave a standing.");
    expect(parseRecord(given).hypotheses[2]?.standing).toBe("supported");
  });
});

describe("slugify", () => {
  test("a title becomes a directory name; an unsluggable one falls back", () => {
    expect(slugify("**Right panel** un-hidable!", "task-1")).toBe("right-panel-un-hidable");
    expect(slugify("Заголовок", "task-7")).toBe("task-7");
    expect(slugify("", "task-2")).toBe("task-2");
  });
});

describe("promoteTask", () => {
  test("writes the child record and brief, and points the parent's line at it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-promote-"));
    const parent = join(dir, "project.md");
    await writeAtomic(parent, REAL);

    const promotion = await promoteTask(parent, "UI iteration", 2, "2026-08-06");
    expect(promotion.child).toBe(join(dir, "composer-height", "project.md"));

    const child = await readFile(promotion.child, "utf8");
    expect(child).toContain("type: project");
    expect(child).toContain("status: framing");
    expect(child).toContain("parent: ../project.md");
    expect(child).toContain("# Composer height");
    expect(child).toContain("**Need.** two lines is too small.");
    expect(child).toContain("## Next");

    const brief = await readFile(join(dir, "composer-height", "brief.md"), "utf8");
    for (const block of [
      "## Who and what this is for",
      "## Inherited — do not re-decide",
      "## This project only",
      "## Not inherited",
    ]) {
      expect(brief).toContain(block);
    }

    // The parent: that one item rewritten, every other line as it was.
    const after = await readFile(parent, "utf8");
    expect(after).toContain("2. [>] **Composer height** — need: two lines is too small.");
    expect(after).toContain("   subproject: composer-height/project.md");
    const task = parseRecord(REAL).tasks[1];
    confined(REAL, after, task?.from ?? 0, task?.to ?? 0);
  });

  test("promoting the same task twice is refused rather than silently forking it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-promote2-"));
    const parent = join(dir, "project.md");
    await writeAtomic(parent, REAL);
    await promoteTask(parent, "UI iteration", 2, "2026-08-06");
    await expect(promoteTask(parent, "UI iteration", 2, "2026-08-06")).rejects.toThrow();
  });
});
