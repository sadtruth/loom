export interface FileRow {
  path: string;
  name: string;
  band: "read" | "code" | "data";
  origins: string[];
  lastTs: string;
  bytes: number;
  pinned: boolean;
}

export interface Folds {
  code: boolean;
  data: boolean;
}

export interface Section {
  title: string;
  rows: FileRow[];
}

export function sections(rows: readonly FileRow[], folds: Folds): Section[] {
  const pinned: FileRow[] = [];
  const read: FileRow[] = [];
  const code: FileRow[] = [];
  const data: FileRow[] = [];

  for (const row of rows) {
    if (row.pinned) {
      pinned.push(row);
    } else if (row.band === "read") {
      read.push(row);
    } else if (row.band === "code") {
      code.push(row);
    } else if (row.band === "data") {
      data.push(row);
    }
  }

  const result: Section[] = [];
  if (pinned.length > 0) result.push({ title: "Pinned", rows: pinned });
  if (read.length > 0) result.push({ title: "Reading", rows: read });
  if (code.length > 0) result.push({ title: "Code", rows: folds.code ? [] : code });
  if (data.length > 0) result.push({ title: "Data", rows: folds.data ? [] : data });

  return result;
}

export function visibleCount(rows: readonly FileRow[], folds: Folds): number {
  return sections(rows, folds).reduce((n, s) => n + s.rows.length, 0);
}
