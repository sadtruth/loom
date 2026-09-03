/**
 * Prototype-name conventions (SPEC 133, 135), pure so the rules are pinnable.
 *
 * A prototype file is `<base>[-v<N>][-<change-slug>]-YYYY-MM-DD.html`, immutable once embedded — a
 * revision is a NEW file, so a chain of versions accumulates on disk and the drawer folds it under
 * the latest. No version marker means v1.
 */

export interface ProtoFile {
  name: string;
  path: string;
  mtime: number;
}

export interface ProtoVersion extends ProtoFile {
  version: number;
  /** The change slug between the version marker and the date, de-slugged: "hover overlay". */
  change: string | null;
  date: string | null;
}

export interface ProtoChain {
  base: string;
  latest: ProtoVersion;
  older: ProtoVersion[];
}

const DATE_RE = /-(\d{4}-\d{2}-\d{2})$/;
const VERSION_RE = /-v(\d+)(?=-|$)/;

export function parseProtoName(file: ProtoFile): ProtoVersion & { base: string } {
  let stem = file.name.replace(/\.html?$/i, "");
  const dateMatch = DATE_RE.exec(stem);
  const date = dateMatch?.[1] ?? null;
  if (dateMatch !== null) stem = stem.slice(0, -dateMatch[0].length);

  const versionMatch = VERSION_RE.exec(stem);
  const version = versionMatch?.[1] !== undefined ? Number.parseInt(versionMatch[1], 10) : 1;
  const base = versionMatch !== null ? stem.slice(0, versionMatch.index) : stem;
  const rawChange = versionMatch !== null ? stem.slice(versionMatch.index + versionMatch[0].length) : "";
  const change = rawChange.replace(/^-/, "").replace(/-/g, " ").trim();

  return { ...file, base: base.length > 0 ? base : stem, version, change: change.length > 0 ? change : null, date };
}

/**
 * Chains grouped by base name, newest work first. Within a chain the highest VERSION leads — mtime
 * would do, except a re-synced old file must never displace v4 from the head row.
 */
export function groupProtos(files: readonly ProtoFile[]): ProtoChain[] {
  const byBase = new Map<string, Array<ProtoVersion & { base: string }>>();
  for (const file of files) {
    const parsed = parseProtoName(file);
    byBase.set(parsed.base, [...(byBase.get(parsed.base) ?? []), parsed]);
  }
  const chains: ProtoChain[] = [];
  for (const [base, versions] of byBase) {
    const sorted = [...versions].sort((a, b) => b.version - a.version || b.mtime - a.mtime);
    const latest = sorted[0];
    if (latest === undefined) continue;
    chains.push({ base, latest, older: sorted.slice(1) });
  }
  return chains.sort((a, b) => b.latest.mtime - a.latest.mtime);
}
