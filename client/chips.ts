/**
 * What a chip SAYS about its destination. Pure and DOM-free, so the rule can be property-tested.
 *
 * User, 2026-08-09: three links in one list all reading "project.md", for three different
 * projects. A chip's label was the last path segment, which is exactly the least informative part
 * of a record's path — every record file in loom is called `project.md`.
 *
 * The kinds and their forms were settled over a clickable prototype
 * (`projects/smart-links/mockups/chips-2026-08-10.html`): three visual families, so the reader knows
 * where a chip goes before clicking it — a place in loom (record, sans + status dot), a file
 * (mono + ▸), a moment in a conversation (amber; not built yet, and not this module's business).
 *
 * What this module does NOT touch: the raw path rides `data-path` unencoded and unchanged
 * (SPEC §12–13), and `paths.ts` — the space-in-path extractor — stays exactly as it is.
 */

export type ChipKind = "record" | "file" | "dir" | "place";

export interface RecordLike {
  path: string;
  title: string;
  status: string;
}

export interface ChipLook {
  kind: ChipKind;
  /** What `/api/file` is asked for — the place suffix is never part of it. */
  path: string;
  /** A heading (`#…`) or a line (`:120`, `:120-140`), already stripped of its marker. */
  place: { heading: string } | { line: number; endLine?: number } | null;
  label: string;
  /** Shown dim after the label: which project a repeated filename belongs to. */
  owner: string | null;
  /** Record status, for the dot the tree uses. Null for everything that is not a record. */
  status: string | null;
}

/** `..` and `.` collapsed — for COMPARING against a record path, never for what the server gets. */
export function normalise(path: string): string {
  if (!path.startsWith("/")) return path;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * Lazy on the file half, so the mark is as LONG as it can be: `app.ts:12:5` is line 12 column 5, and
 * a greedy file half read it as `app.ts:12` plus line 5 — the wrong line, found by property 42's
 * line:column case before this ever rendered.
 */
const PLACE = /^(?<file>.*?[^/])(?<mark>#[^#/]+|:\d+(?:[:-]\d+)?)$/u;

/**
 * Split `SPEC.md#path-chips` / `app.ts:2911` into the file and the place inside it.
 *
 * Deliberately conservative: the file half must still look like a path with a segment in it, so a
 * bare `#tag` or a `:` in prose cannot turn into a chip that asks the server for nothing.
 */
export function splitPlace(raw: string): { path: string; place: ChipLook["place"] } {
  // `#L590` is how GitHub, and therefore half the web, names a line. Read as a heading it can only
  // ever miss; read as a line it lands. Normalised here so every caller gets the same answer.
  const github = /^(.*[^/])#L(\d+)(?:-L?(\d+))?$/u.exec(raw);
  if (github !== null) {
    raw = `${github[1] ?? ""}:${github[2] ?? ""}${github[3] === undefined ? "" : `-${github[3]}`}`;
  }
  const found = PLACE.exec(raw);
  const file = found?.groups?.["file"] ?? "";
  const mark = found?.groups?.["mark"] ?? "";
  if (found === null || !file.includes("/") || file.endsWith("/")) return { path: raw, place: null };
  if (mark.startsWith("#")) {
    const heading = mark.slice(1).trim();
    return heading.length === 0 ? { path: raw, place: null } : { path: file, place: { heading } };
  }
  // `:12:5` is an editor's line:column — the line is the part loom can act on. `:12-40` is a RANGE,
  // and it used to be read as the line alone with `-40` left behind in the prose: the chip landed on
  // the first line and the span was lost with no sign of it (link kind 7).
  const body = mark.slice(1);
  const line = Number.parseInt(body.split(/[:-]/u)[0] ?? "", 10);
  if (!Number.isFinite(line) || line <= 0) return { path: raw, place: null };
  const dash = /^\d+-(\d+)$/u.exec(body);
  const end = dash === null ? Number.NaN : Number.parseInt(dash[1] ?? "", 10);
  return Number.isFinite(end) && end > line
    ? { path: file, place: { line, endLine: end } }
    : { path: file, place: { line } };
}

/**
 * The `data-place` string for a split place — `#a-heading`, `:120`, `:120-140`.
 *
 * Written once and used twice: `labelChips` below, and `chipPathLinks` in `markdown.ts`, which
 * makes chips `labelChips` deliberately never touches. Before this existed the second pass simply
 * did not set a place at all, and every `[label](path:86)` link asked the disk for a file whose name
 * ended in `:86` — 147 of them in the 2026-08-24 audit (item 12).
 */
export function placeMark(place: ChipLook["place"]): string | null {
  if (place === null) return null;
  if ("heading" in place) return `#${place.heading}`;
  return `:${place.line}${place.endLine === undefined ? "" : `-${place.endLine}`}`;
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export function baseName(path: string): string {
  return segments(path).slice(-1)[0] ?? path;
}

/** The record whose directory contains this path, deepest first — a child owns before its parent. */
export function enclosingRecord(path: string, records: readonly RecordLike[]): RecordLike | null {
  const target = normalise(path);
  let best: RecordLike | null = null;
  let bestDepth = -1;
  for (const record of records) {
    const dir = normalise(record.path).replace(/\/[^/]*$/u, "");
    if (target !== dir && !target.startsWith(`${dir}/`)) continue;
    const depth = segments(dir).length;
    if (depth > bestDepth) {
      best = record;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * The whole label rule.
 *
 * `ambiguous` answers "does this filename appear more than once in what the reader can see?" — the
 * owner suffix is noise on a name that is already unique, and the only thing that saves a list of
 * three `project.md`s. Scope is the caller's (one rendered message), because that is the list the
 * reader is comparing across.
 */
export function chipLook(
  raw: string,
  records: readonly RecordLike[],
  ambiguous: (base: string) => boolean = () => false,
): ChipLook {
  const { path, place } = splitPlace(raw.trim());
  const record = records.find((r) => normalise(r.path) === normalise(path));

  // 1 · a record is a PLACE: its own title, and the tree's status dot. A place suffix cannot make a
  // record file into something else — `project.md#frame` is still that project.
  if (record !== undefined && place === null) {
    return { kind: "record", path, place: null, label: record.title, owner: null, status: record.status };
  }

  const base = baseName(path);
  const owner = enclosingRecord(path, records);

  // 4a · a WORK ITEM inside a record is the record, at a row — not a heading in a document. It is
  // the form `CLAUDE.md` rule 45 mandates for every task link, so it is the commonest place-chip
  // there is, and reading it as a heading made it say `project.md § next 12` (link kind 17).
  const item = record !== undefined && place !== null && "heading" in place
    ? /^next\s+(\d+)$/i.exec(place.heading)
    : null;
  if (record !== undefined && item !== null) {
    return {
      kind: "record",
      path,
      place,
      label: `${record.title} · item ${item[1] ?? ""}`,
      owner: null,
      status: record.status,
    };
  }

  // 4 · a place inside a file names the file AND the place; the label is the whole point of it.
  if (place !== null) {
    const where =
      "heading" in place ? ` § ${place.heading}` : `:${place.line}${place.endLine === undefined ? "" : `-${place.endLine}`}`;
    return {
      kind: "place",
      path,
      place,
      label: `${base}${where}`,
      owner: ambiguous(base) ? (owner?.title ?? null) : null,
      status: null,
    };
  }

  // 3 · a directory — only a trailing slash can prove one client-side, and that is enough: the
  // reader wrote it, and the pane's listing handles the undeclared case anyway.
  if (raw.trim().endsWith("/")) {
    return { kind: "dir", path, place: null, label: `${base}/`, owner: null, status: null };
  }

  // 2 · a file. `project.md` that is NOT a known record would say nothing at all, so it borrows its
  // directory's name — the record may simply not be scanned yet.
  const label = base === "project.md" ? (segments(path).slice(-2)[0] ?? base) : base;
  return {
    kind: "file",
    path,
    place: null,
    label,
    owner: ambiguous(base) ? (owner?.title ?? null) : null,
    status: null,
  };
}


/**
 * A status as a CSS class token. A record's `status:` is free text — the work core writes it in
 * Russian ("результат собран") — and a token containing a space throws `InvalidCharacterError` out
 * of `classList.add`, which took the whole transcript render down with it (2026-08-28). Unknown
 * statuses simply get no colour; nothing else changes.
 */
export function statusClass(status: string): string {
  return status
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}


const KIND_CLASS: Record<ChipKind, string> = {
  record: "chip rec",
  file: "chip file",
  dir: "chip dir",
  place: "chip place",
};

/**
 * Give every chip under `root` its label, kind and target — and do it again whenever the record list
 * changes, which is why it reads `data-raw` instead of the text it wrote last time.
 *
 * Ambiguity is scoped to `root`: a `project.md` is uninformative in a list of three of them and
 * perfectly clear on its own, so the owner suffix appears exactly where it earns its width.
 */
export function labelChips(root: ParentNode, records: readonly RecordLike[]): void {
  const chips = [...root.querySelectorAll<HTMLElement>(".chip[data-raw]")].filter(
    (chip) => chip.dataset["fixed"] === undefined,
  );

  const seen = new Map<string, Set<string>>();
  for (const chip of chips) {
    const raw = chip.dataset["raw"] ?? "";
    const { path } = splitPlace(raw.trim());
    const paths = seen.get(baseName(path)) ?? new Set<string>();
    paths.add(normalise(path));
    seen.set(baseName(path), paths);
  }
  const ambiguous = (base: string): boolean => (seen.get(base)?.size ?? 0) > 1;

  for (const chip of chips) {
    const look = chipLook(chip.dataset["raw"] ?? "", records, ambiguous);
    chip.className = KIND_CLASS[look.kind];
    const status = look.status === null ? "" : statusClass(look.status);
    if (status !== "") chip.classList.add(status);
    chip.dataset["path"] = look.path;
    const mark = placeMark(look.place);
    if (mark === null) delete chip.dataset["place"];
    else chip.dataset["place"] = mark;
    chip.title = chip.dataset["raw"] ?? look.path;

    chip.replaceChildren(look.label);
    if (look.owner !== null) {
      const owner = document.createElement("span");
      owner.className = "owner";
      owner.textContent = `· ${look.owner}`;
      chip.append(owner);
    }
  }
}
