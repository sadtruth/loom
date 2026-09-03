/**
 * The build plan, parsed — SPEC §Rich blocks (147–152).
 *
 * A plan is a markdown file: frontmatter for the machine half, `##` sections for the human half,
 * and inside a section either prose, a numbered list, or `###` items carrying `label: value` field
 * lines. The field grammar is the record's own (SPEC §Tasks 53), deliberately: one parser shape for
 * both, and a label ends the previous field's clause wherever it appears.
 *
 * No DOM here. The block's whole correctness claim — every required field absent from the file
 * shows as a gap, never as a shorter block — is a claim about this module's output, so it is
 * property-testable without a browser.
 */

/** One `label: value` clause inside an item. */
export interface PlanField {
  label: string;
  value: string;
}

/** A `###` item: a requirement, a scenario, an object. */
export interface PlanItem {
  title: string;
  fields: PlanField[];
  /** Everything in the item that was not a field line, in order. */
  prose: string[];
}

export interface PlanSection {
  title: string;
  items: PlanItem[];
  prose: string[];
}

export interface PlanDoc {
  front: Map<string, string>;
  title: string;
  sections: PlanSection[];
  /** Lines that could not be parsed at all — never thrown, always counted. */
  skipped: number;
}

const FIELD = /^([A-Za-z][A-Za-z ]{0,24}):\s*(.*)$/;

/**
 * `![caption](path)` alone on its line — the third place a plan may show a picture (SPEC 167).
 * Here rather than in the renderer or the rules, because both of them need the same answer: the
 * block draws it, and the mention rule must not demand backticks around a path it already links.
 */
export const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

/** `[a, b, c]` or `a, b` or a single value — always a list, possibly of one. */
export function asList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parse the whole document. Never throws: a file that is not a plan at all comes back with an empty
 * front map and no sections, which is exactly what the renderer draws as a block full of gaps.
 */
export function parsePlan(text: string): PlanDoc {
  const front = new Map<string, string>();
  let body = text;
  let skipped = 0;

  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end >= 0) {
      for (const line of text.slice(4, end).split("\n")) {
        if (line.trim().length === 0) continue;
        const match = FIELD.exec(line);
        if (match?.[1] === undefined) {
          skipped += 1;
          continue;
        }
        front.set(match[1].trim().toLowerCase(), (match[2] ?? "").trim());
      }
      body = text.slice(end + 4);
    }
  }

  const sections: PlanSection[] = [];
  let title = "";
  let section: PlanSection | null = null;
  let item: PlanItem | null = null;
  let pending: PlanField | null = null;

  const closeField = (): void => {
    if (pending !== null && item !== null) item.fields.push(pending);
    pending = null;
  };
  const trimTail = (prose: string[]): void => {
    while (prose.length > 0 && prose[prose.length - 1] === "") prose.pop();
  };
  const closeItem = (): void => {
    closeField();
    if (item !== null && section !== null) {
      trimTail(item.prose); // the blank before the next `###` is a boundary, not a paragraph break
      section.items.push(item);
    }
    item = null;
  };
  const closeSection = (): void => {
    closeItem();
    if (section !== null) {
      trimTail(section.prose);
      sections.push(section);
    }
    section = null;
  };

  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();

    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1?.[1] !== undefined) {
      closeSection();
      title = h1[1].trim();
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2?.[1] !== undefined) {
      closeSection();
      section = { title: h2[1].trim(), items: [], prose: [] };
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3?.[1] !== undefined) {
      closeItem();
      item = { title: h3[1].trim(), fields: [], prose: [] };
      continue;
    }

    if (line.trim().length === 0) {
      closeField();
      // A blank line is CONTENT: it is the only thing that says where one paragraph ends and the
      // next begins. Dropping it made every hard-wrapped source line render as its own orphan
      // paragraph (User, 2026-08-11, with screenshots). Never two in a row, never leading.
      const into = item?.prose ?? section?.prose ?? null;
      if (into !== null && into.length > 0 && into[into.length - 1] !== "") into.push("");
      continue;
    }

    // A markdown table is never a field's continuation — it is content in its own right, and
    // absorbing it turned the schema table into a wall of pipes (found in the browser, 2026-08-10).
    if (line.trimStart().startsWith("|")) {
      closeField();
      if (item !== null) item.prose.push(line.trim());
      else if (section !== null) section.prose.push(line.trim());
      else skipped += 1;
      continue;
    }

    const field = FIELD.exec(line);
    // A label ends the previous clause wherever it appears (SPEC 53), so a value that itself
    // contains a colon-word cannot swallow the field after it.
    if (field?.[1] !== undefined && item !== null) {
      closeField();
      pending = { label: field[1].trim().toLowerCase(), value: (field[2] ?? "").trim() };
      continue;
    }
    // Only an INDENTED line continues a field — the record grammar's own rule (SPEC 53). Without
    // it a requirement's body text was swallowed into its `spec:` value and the section read as one
    // garbled run-on (User, 2026-08-10: "the requirements section reads like a garbled mess").
    if (pending !== null && /^\s/.test(raw)) {
      pending.value = `${pending.value} ${line.trim()}`.trim();
      continue;
    }
    closeField();
    if (item !== null) {
      item.prose.push(line.trim());
      continue;
    }
    if (section !== null) {
      section.prose.push(line.trim());
      continue;
    }
    skipped += 1;
  }
  closeSection();

  return { front, title, sections, skipped };
}

/** A field of an item, by label — null when it is absent, which the renderer draws as a gap. */
export function fieldOf(item: PlanItem, label: string): string | null {
  return item.fields.find((f) => f.label === label)?.value ?? null;
}

export function sectionOf(doc: PlanDoc, title: string): PlanSection | null {
  const wanted = title.toLowerCase();
  return doc.sections.find((s) => s.title.toLowerCase() === wanted) ?? null;
}

export type Size = "S" | "M" | "L";
/** `derived` is filled by the machine, never typed — the reader still needs to see it in the table. */
export type Need = "required" | "optional" | "absent" | "derived";

/**
 * The schema, in one place — the same table the plan document prints, so the check and the
 * document cannot disagree (SPEC 152). `front` fields are keys of the frontmatter map;
 * `section` fields are `##` section titles.
 */
export const SCHEMA: ReadonlyArray<{
  field: string;
  where: "front" | "section" | "derived";
  S: Need;
  M: Need;
  L: Need;
}> = [
  { field: "id", where: "front", S: "required", M: "required", L: "required" },
  { field: "records", where: "front", S: "required", M: "required", L: "required" },
  { field: "size", where: "front", S: "required", M: "required", L: "required" },
  { field: "git", where: "front", S: "required", M: "required", L: "required" },
  { field: "work", where: "front", S: "required", M: "required", L: "required" },
  { field: "estimate", where: "front", S: "required", M: "required", L: "required" },
  { field: "stack", where: "front", S: "optional", M: "required", L: "required" },
  { field: "prototype", where: "front", S: "absent", M: "optional", L: "required" },
  { field: "deploy", where: "front", S: "optional", M: "optional", L: "required" },
  { field: "Log", where: "section", S: "required", M: "required", L: "required" },
  // Empty while a build runs and required to close it (SPEC 156) — the schema cannot say "at
  // close", so it is optional here and `land` is what refuses a build that found nothing.
  { field: "Found during the build", where: "section", S: "optional", M: "optional", L: "optional" },
  { field: "Scenarios", where: "section", S: "optional", M: "required", L: "required" },
  { field: "Quality", where: "section", S: "optional", M: "required", L: "required" },
  { field: "Update afterwards", where: "section", S: "optional", M: "required", L: "required" },
  { field: "Requirements", where: "section", S: "absent", M: "optional", L: "required" },
  { field: "Objects", where: "section", S: "absent", M: "optional", L: "required" },
  { field: "Subagents", where: "section", S: "absent", M: "absent", L: "required" },
  { field: "Code validation", where: "section", S: "absent", M: "absent", L: "required" },
  { field: "Deployment", where: "section", S: "optional", M: "optional", L: "required" },
  // COLLECTED, not written (SPEC 157): every other plan in the records' own directories whose
  // `records:` names one of them. It earns a row because a field list that omits a section the
  // block renders is a field list nobody can trust — User, 2026-08-11, item 7.
  { field: "Builds before this", where: "derived", S: "derived", M: "derived", L: "derived" },
];

export function planSize(doc: PlanDoc): Size {
  const raw = (doc.front.get("size") ?? "").trim().toUpperCase();
  return raw === "S" || raw === "L" ? raw : "M";
}

/** Present means: the key exists AND carries something. An empty value is a gap, not a value. */
export function isPresent(doc: PlanDoc, entry: (typeof SCHEMA)[number]): boolean {
  if (entry.where === "derived") return true; // the machine fills it; absence is never the plan's fault
  if (entry.where === "front") return (doc.front.get(entry.field.toLowerCase()) ?? "").length > 0;
  const section = sectionOf(doc, entry.field);
  if (section === null) return false;
  return section.items.length > 0 || section.prose.length > 0;
}

/**
 * Every required field this plan does not carry. The block draws one gap per entry and the gate
 * refuses `build start` naming them — one list, two consumers.
 */
export function missingFields(doc: PlanDoc): string[] {
  // A derived field can never be "missing": nobody types it, so its absence is the machine's
  // business and never a reason to refuse a plan.
  const size = planSize(doc);
  return SCHEMA.filter((entry) => entry[size] === "required" && !isPresent(doc, entry)).map(
    (entry) => entry.field,
  );
}
