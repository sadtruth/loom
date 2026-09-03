/**
 * What a chip DOES when it is clicked, decided from the chip loom actually built and the answer
 * loom's own server actually gave.
 *
 * This is the one modelled part of the audit, and it is deliberately small and pure so it can be
 * read and argued with. Everything upstream of it is real — the chip comes out of `renderMarkdown`
 * in a browser, the status and the file kind come out of `/api/file` — and everything here is the
 * click routing in `client/app.ts` and the landing rules in `client/filepane.ts`, restated. Where
 * this file and the product disagree, the product is right and this file is a bug; the driven
 * spot-check in `link-audit.ts` exists to catch exactly that.
 */

/** What the server said about the path, when it was asked. */
export interface ServerAnswer {
  status: number;
  /** The refusal text, verbatim, for a non-200. */
  reason: string;
  kind: "markdown" | "text" | "dir" | "image" | "binary" | "page" | null;
  /** Line count. Needed for a rendered document too since SPEC 243 gave its blocks source lines. */
  lines: number | null;
  /** Heading slugs found in a markdown file. */
  headings: readonly string[] | null;
}

export interface ChipFacts {
  raw: string;
  path: string;
  place: string | null;
  label: string;
  fixed: boolean;
  wiki: boolean;
  /** The chip points at a scanned record — the click enters the project instead of the file pane. */
  isRecord: boolean;
  /** For a record chip: the `Next` item numbers the record actually has. */
  recordItems: readonly number[] | null;
}

export type Cause =
  | "ok"
  | "place-never-split"
  | "server-refused"
  | "html-as-source"
  /** Kept as a regression detector; SPEC 243 made it unreachable. */
  | "line-in-rendered-markdown"
  | "heading-in-source-view"
  | "line-past-end"
  | "heading-not-found"
  | "task-not-in-record"
  | "external-no-new-tab"
  | "path-not-recognised";

export interface Verdict {
  cause: Cause;
  /** One sentence, in product language, for the report's group heading. */
  says: string;
}

/** A place suffix still glued to the end of a path — the shape `splitPlace` should have removed. */
const GLUED = /(?::\d+(?:[:-]\d+)?|#(?:next\s+\d+|[\p{L}\p{N}_-]+))$/u;

/** `landOn`'s own slug rule (`client/filepane.ts`), restated. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "");
}

/**
 * One refusal, said the same way however many different paths produced it.
 *
 * The server's reason for a relative miss names the directory it searched from, so grouping on the
 * raw string turned one piece of work into fifty one-line sections — which is exactly the report
 * being useless that requirement "failures are grouped by cause" is about. The verbatim reason
 * still travels with each example; only the GROUP is normalised.
 */
export function family(reason: string): string {
  if (/^not found from .* or its ancestors$/u.test(reason)) return "a relative path that resolves from nowhere";
  if (reason === "not found") return "the file is not there any more";
  if (/outside loom's readable roots/u.test(reason)) return "outside the directories loom may read";
  if (/^denied /u.test(reason)) return "a file loom refuses to show through a browser";
  if (/too large/u.test(reason)) return "too large to read in the pane";
  if (/binary|not a readable kind/u.test(reason)) return "not a kind the pane can show";
  if (/^no note named/u.test(reason)) return "no vault note by that name";
  if (/absolute path required|bad path|path required/u.test(reason)) return "not a path loom could parse";
  return reason;
}

export function judge(chip: ChipFacts, answer: ServerAnswer | null): Verdict {
  // An anchor that no chip pass claimed. External is fine as long as it leaves in a new tab; a
  // filesystem path left as a bare anchor is a link that does nothing at all.
  if (chip.wiki && answer !== null && answer.status === 404) {
    return { cause: "server-refused", says: "no vault note by that name" };
  }

  // The clicked path still carries its own place suffix and the chip has no place: `splitPlace`
  // never ran, so the server is asked for a file whose name ends in `:86`.
  if (chip.place === null && !chip.wiki && GLUED.test(chip.path) && chip.fixed) {
    return {
      cause: "place-never-split",
      says: "the `:line` or `#place` stayed glued to the filename, so the file was never found",
    };
  }

  // A record chip with a task place: the click enters the record and scrolls to the item.
  if (chip.isRecord && chip.place !== null) {
    const task = /^#\s*next\s+(\d+)\s*$/i.exec(chip.place);
    if (task !== null) {
      const wanted = Number.parseInt(task[1] ?? "", 10);
      if (chip.recordItems !== null && !chip.recordItems.includes(wanted)) {
        return { cause: "task-not-in-record", says: "the record has no work item with that number" };
      }
      return { cause: "ok", says: "enters the record and lands on the item" };
    }
  }
  if (chip.isRecord && chip.place === null) return { cause: "ok", says: "enters the project" };

  if (answer === null) return { cause: "ok", says: "not asked" };

  if (answer.status !== 200) {
    return { cause: "server-refused", says: answer.reason };
  }

  if (answer.kind === "dir") return { cause: "ok", says: "opens as a directory listing" };

  // Fixed 2026-08-24 (SPEC 241): `kindOf` answers `page` before the text list can claim `html?`.
  // The check stays as a REGRESSION detector — if loom ever calls an `.html` file text again, this
  // is where 24 links come back.
  if (answer.kind === "text" && /\.html?$/i.test(chip.path)) {
    return { cause: "html-as-source", says: "an HTML page opens as its source code, not as a page" };
  }
  if (answer.kind === "page") return { cause: "ok", says: "runs as a page" };

  if (chip.place === null) return { cause: "ok", says: "opens" };

  if (chip.place.startsWith("#")) {
    if (answer.kind !== "markdown") {
      return {
        cause: "heading-in-source-view",
        says: "a heading cannot be found in a file shown as source — only rendered markdown has headings",
      };
    }
    const want = slug(chip.place.slice(1));
    if ((answer.headings ?? []).includes(want)) return { cause: "ok", says: "opens and lands on the heading" };
    return { cause: "heading-not-found", says: "the file has no heading by that name" };
  }

  // A line number. Until 2026-08-24 a rendered markdown file could not honour one at all; SPEC 243
  // gives every top-level block the source line it starts at, so the only way to miss now is to
  // name a line past the end of the file — the same rule as a source view.
  const first = Number.parseInt(chip.place.slice(1).split("-")[0] ?? "", 10);
  if (!Number.isFinite(first)) return { cause: "ok", says: "opens" };
  if (answer.lines !== null && first > answer.lines) {
    return { cause: "line-past-end", says: "the file is shorter than the line the link names" };
  }
  return { cause: "ok", says: "opens and lands on the line" };
}
