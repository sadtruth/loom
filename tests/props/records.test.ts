/**
 * The record scanner's contract (SPEC §Records): only `type: project` frontmatter is a record,
 * paths resolve against the record's directory, and malformed input degrades to "not a record" —
 * the same no-throwing-path rule as the transcript parser.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { Core } from "../../server/cores.ts";
import { frameOf, parseRecord, scanRecords } from "../../server/records.ts";

const RECORD = `---
type: project
status: active
created: 2026-08-04
---

# Panda game

Body text.
`;

const CHILD = `---
type: project
status: framing
parent: ../parent/project.md
references:
  - path: ../shared/notes.md
    why: the design source
  - path: /abs/other.md
---

## No heading of h1 depth
`;

describe("parseRecord", () => {
  test("a plain record parses: title from H1, fields from frontmatter", () => {
    const record = parseRecord(RECORD, "/x/toys/panda-walk.md", 5);
    expect(record).not.toBeNull();
    expect(record?.title).toBe("Panda game");
    expect(record?.status).toBe("active");
    expect(record?.created).toBe("2026-08-04");
    expect(record?.parent).toBeNull();
  });

  test("parent and references resolve against the record's directory", () => {
    const record = parseRecord(CHILD, "/x/projects/child/project.md", 5);
    expect(record?.parent).toBe("/x/projects/parent/project.md");
    expect(record?.references).toEqual([
      { path: "/x/projects/shared/notes.md", why: "the design source" },
      { path: "/abs/other.md", why: null },
    ]);
    // No H1 → a project.md is titled by its directory.
    expect(record?.title).toBe("child");
  });

  test("non-project frontmatter and non-frontmatter files are not records", () => {
    expect(parseRecord("---\ntype: note\n---\nx", "/x/a.md", 1)).toBeNull();
    expect(parseRecord("# just markdown", "/x/b.md", 1)).toBeNull();
    expect(parseRecord("---\nunclosed frontmatter", "/x/c.md", 1)).toBeNull();
  });

  test("property: arbitrary text never throws, and every record it does yield says type: project", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const record = parseRecord(text, "/x/y.md", 1);
        if (record !== null) expect(text).toContain("type: project");
      }),
    );
  });
});

describe("scanRecords", () => {
  test("finds records in nested dirs, skips non-records and skip-listed dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-records-"));
    mkdirSync(join(root, "parent"));
    mkdirSync(join(root, "parent", "child"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "parent", "project.md"), RECORD);
    writeFileSync(
      join(root, "parent", "child", "project.md"),
      "---\ntype: project\nstatus: framing\nparent: ../project.md\n---\n# Child\n",
    );
    writeFileSync(join(root, "parent", "notes.md"), "# not a record\n");
    writeFileSync(join(root, "node_modules", "project.md"), RECORD);

    const records = await scanRecords([root]);
    expect(records).toHaveLength(2);
    const child = records.find((r) => r.title === "Child");
    expect(child?.parent).toBe(join(root, "parent", "project.md"));
  });

  test("a missing root contributes nothing", async () => {
    expect(await scanRecords(["/no/such/dir"])).toEqual([]);
  });
});

/**
 * A core may declare a folder whose subdirectories are its records — the work vault's `epics/`.
 * The FOLDER is what makes them records, so no `type:` is demanded: ten of User's 22 epics say
 * `type: epic` and the rest say `type: task` or nothing, and the work dashboard reads none of it.
 */
describe("scanRecords over a core's own record folder", () => {
  const EPIC = `---
eva: SMOT-7121
type: task
status: In Progress
priority: P1
---

Body with no H1.
`;

  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), "loom-folder-records-"));
    mkdirSync(join(root, "epics", "SMOT-7121 Сейчас в эфире", "prototype"), { recursive: true });
    mkdirSync(join(root, "epics", "DRAFT Локальный поиск"), { recursive: true });
    mkdirSync(join(root, "epics", "архив", "ML-1489 Ещё интересное персоны"), { recursive: true });
    mkdirSync(join(root, "epics", "no-frontmatter"), { recursive: true });
    writeFileSync(join(root, "epics", "SMOT-7121 Сейчас в эфире", "README.md"), EPIC);
    writeFileSync(join(root, "epics", "SMOT-7121 Сейчас в эфире", "prototype", "README.md"), EPIC);
    writeFileSync(
      join(root, "epics", "DRAFT Локальный поиск", "README.md"),
      "---\nstatus: draft\n---\n# Локальный поиск\n",
    );
    writeFileSync(join(root, "epics", "архив", "README.md"), "---\nstatus: archive\n---\n# Архив\n");
    writeFileSync(join(root, "epics", "архив", "ML-1489 Ещё интересное персоны", "README.md"), EPIC);
    writeFileSync(join(root, "epics", "no-frontmatter", "README.md"), "# just a readme\n");
    return root;
  }

  function coresFor(root: string): Core[] {
    return [
      {
        id: "work",
        label: "Work",
        cwd: root,
        owns: [root],
        home: join(root, "projects"),
        records: { dir: join(root, "epics"), file: "README.md", skip: ["архив"] },
      },
    ];
  }

  test("one record per subdirectory, whatever its frontmatter type says", async () => {
    const root = tree();
    const records = await scanRecords([root], coresFor(root));

    // Two records: the epic and the draft. NOT the nested `prototype`, NOT anything under `архив`,
    // NOT the directory whose README carries no frontmatter.
    expect(records.map((r) => r.title).sort()).toEqual(["SMOT-7121 Сейчас в эфире", "Локальный поиск"].sort());
    const epic = records.find((r) => r.title === "SMOT-7121 Сейчас в эфире");
    expect(epic?.status).toBe("In Progress"); // its own vocabulary, not loom's
    expect(epic?.core).toBe("work"); // tagged by the core that declared the folder
    expect(epic?.parent).toBeNull();
  });

  test("a core's folder outside the scanned roots contributes nothing", async () => {
    const root = tree();
    const elsewhere = mkdtempSync(join(tmpdir(), "loom-other-root-"));
    expect(await scanRecords([elsewhere], coresFor(root))).toEqual([]);
  });

  test("a work epic's frame is its `Цель и контекст`, and the first heading wins", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-frame-"));
    const epic = join(root, "README.md");
    writeFileSync(epic, "---\ntype: task\n---\n\n# SMOT-7121\n\n## Цель и контекст\n\nПерсонализация эфира.\n\n## Декомпозиция\n\nx\n");
    expect(await frameOf(epic)).toBe("## Цель и контекст\n\nПерсонализация эфира.");

    const both = join(root, "both.md");
    writeFileSync(both, "---\ntype: project\n---\n\n## Frame\n\nThe bet.\n\n## Цель и контекст\n\nlater\n");
    expect(await frameOf(both)).toBe("## Frame\n\nThe bet.");

    const neither = join(root, "neither.md");
    writeFileSync(neither, "---\ntype: task\n---\n\n# No frame anywhere\n\n## Декомпозиция\n\nx\n");
    expect(await frameOf(neither)).toBeNull();
  });

  test("the same file is never both a project record and a folder record", async () => {
    const root = tree();
    const dir = join(root, "epics", "SMOT-8000 Двойной учёт");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "---\ntype: project\nstatus: active\n---\n# Двойной учёт\n");

    const records = await scanRecords([root], coresFor(root));
    expect(records.filter((r) => r.title === "Двойной учёт")).toHaveLength(1);
  });
});
