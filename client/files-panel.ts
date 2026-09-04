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
  const pinnedRows = rows.filter(r => r.pinned);
  const readRows = rows.filter(r => r.band === "read" && !r.pinned);
  const codeRows = rows.filter(r => r.band === "code" && !r.pinned);
  const dataRows = rows.filter(r => r.band === "data" && !r.pinned);

  const sectionsList: Section[] = [];

  if (pinnedRows.length > 0) {
    sectionsList.push({ title: "Pinned", rows: pinnedRows });
  }
  if (readRows.length > 0) {
    sectionsList.push({ title: "Reading", rows: readRows });
  }

  if (folds.code) {
    if (codeRows.length > 0) sectionsList.push({ title: "Code", rows: [] });
  } else {
    if (codeRows.length > 0) sectionsList.push({ title: "Code", rows: codeRows });
  }

  if (folds.data) {
    if (dataRows.length > 0) sectionsList.push({ title: "Data", rows: [] });
  } else {
    if (dataRows.length > 0) sectionsList.push({ title: "Data", rows: dataRows });
  }

  return sectionsList;
}

export function visibleCount(rows: readonly FileRow[], folds: Folds): number {
  return sections(rows, folds).reduce((n, s) => n + s.rows.length, 0);
}
