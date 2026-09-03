/**
 * Which records the project panel draws (SPEC 88–93).
 *
 * Three filters now decide the panel's contents, and they are all the same operation: keep a set,
 * then keep every ancestor of what was kept. Pure on purpose — the panel's rules are the part worth
 * property-pinning, and a function that touches `localStorage` or the DOM cannot be.
 */

/** The shape `treeView` needs. The client's `RecordInfo` is a superset. */
export interface PanelRecord {
  path: string;
  status: string;
  parent: string | null;
  mtime: number;
  /**
   * Which core owns this record. Tagged by the server (`server/records.ts`), never derived here.
   * Optional so the panel's other axes stay testable without inventing a core for every fixture;
   * a record with none is only ever visible when no core is chosen.
   */
  core?: string;
  /** The derived staleness (freshest timestamp over itself, its sessions, and its descendants). */
  derivedMtime?: number;
}

export interface PanelOptions {
  /** Now, in epoch ms — passed in so the recency window is testable without a clock. */
  now: number;
  /** The record the panel is narrowed to, or null. A path the scan does not return is ignored. */
  focus: string | null;
  /** Recency off: every record is current work. Ignored while focused. */
  showOlder: boolean;
  /** The status fold open: finished projects are listed like any other. */
  showFinished: boolean;
  /** Where he is standing. Always shown, so a deep link can never land on a hidden record. */
  active: string | null;
  /**
   * The core being looked at, or null for all of them. A SCOPE rather than an attention filter: it
   * decides which tree this is before any axis below runs, and it lives in the URL rather than on
   * the device, so two tabs can sit in two cores without touching each other.
   */
  core?: string | null;
}

export interface PanelView {
  visible: Set<string>;
  /** The focused record's path once resolved against the scan, or null. */
  focus: string | null;
  /** Records hidden by the recency window. Zero while focused — focus replaces that filter. */
  hiddenOlder: number;
  /** Records hidden for being over. Excludes any that came back as somebody's ancestor. */
  hiddenFinished: number;
  /** Records outside the focused subtree. Zero when not focused. */
  hiddenUnfocused: number;
  /** Records belonging to another core. Zero when no core is chosen. */
  hiddenOtherCore: number;
}

/** Records touched inside this window are "current work"; older ones sit behind one click. */
export const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A project whose work is OVER. `parked` is deliberately NOT here: a parked project is a decision
 * waiting to be revisited, and folding it away is how it gets forgotten. Focus is the mechanism for
 * "not now"; this fold is the mechanism for "finished".
 */
export const FINISHED = new Set(["done", "abandoned"]);

/** Children by parent path, with an unresolvable parent treated as a root — the tree's own rule. */
function childrenOf(records: readonly PanelRecord[]): Map<string | null, PanelRecord[]> {
  const known = new Set(records.map((r) => r.path));
  const map = new Map<string | null, PanelRecord[]>();
  for (const record of records) {
    const key = record.parent !== null && known.has(record.parent) ? record.parent : null;
    map.set(key, [...(map.get(key) ?? []), record]);
  }
  return map;
}

export function treeView(records: readonly PanelRecord[], options: PanelOptions): PanelView {
  // The core narrows WHICH TREE this is, before any axis below. Connectivity must not reach across
  // it, and does not need to: a record's parent lives in its own core by construction.
  const wanted = options.core ?? null;
  const scoped = wanted === null ? records : records.filter((r) => r.core === wanted);
  const hiddenOtherCore = records.length - scoped.length;
  const byPath = new Map(scoped.map((r) => [r.path, r]));
  const focused = options.focus !== null ? (byPath.get(options.focus) ?? null) : null;

  // ── the attention axis. Focus REPLACES recency rather than stacking with it: naming what matters
  //    says more than a timestamp does, so a focused project's subtree shows whole, however old.
  const base = new Set<string>();
  if (focused !== null) {
    const children = childrenOf(scoped);
    const walk = (path: string): void => {
      if (base.has(path)) return; // a cycle in `parent:` is a malformed record, not a hang
      base.add(path);
      for (const kid of children.get(path) ?? []) walk(kid.path);
    };
    walk(focused.path);
  } else {
    const floor = options.now - RECENT_MS;
    for (const record of scoped) {
      const activeTime = record.derivedMtime ?? record.mtime;
      if (options.showOlder || activeTime >= floor) base.add(record.path);
    }
  }

  // ── the status axis. Applies inside a focus too: the two answer different questions.
  const kept = new Set<string>();
  for (const path of base) {
    if (!options.showFinished && FINISHED.has(byPath.get(path)?.status ?? "")) continue;
    kept.add(path);
  }

  // ── connectivity. A tree with a hole in it is not a tree, so ancestors come back UNCONDITIONALLY
  //    — which is exactly why a finished parent still holding live work stays on screen.
  const visible = new Set<string>();
  const addWithAncestors = (record: PanelRecord | undefined): void => {
    let cursor = record;
    while (cursor !== undefined && !visible.has(cursor.path)) {
      visible.add(cursor.path);
      cursor = cursor.parent !== null ? byPath.get(cursor.parent) : undefined;
    }
  };
  for (const path of kept) addWithAncestors(byPath.get(path));
  if (focused !== null) addWithAncestors(focused);
  if (options.active !== null) addWithAncestors(byPath.get(options.active));

  // ── the counts are read off the RESULT, never off the intent. Counted before the ancestor pass
  //    they would announce "+1 finished" about a record sitting in plain sight (SPEC 90).
  let hiddenOlder = 0;
  let hiddenFinished = 0;
  let hiddenUnfocused = 0;
  for (const record of scoped) {
    if (visible.has(record.path)) continue;
    if (focused !== null && !base.has(record.path)) hiddenUnfocused += 1;
    else if (base.has(record.path)) hiddenFinished += 1;
    else hiddenOlder += 1;
  }
  return { visible, focus: focused?.path ?? null, hiddenOlder, hiddenFinished, hiddenUnfocused, hiddenOtherCore };
}

// ── the Active list (SPEC 247) ───────────────────────────────────────

/**
 * How long after User types somewhere that place still counts as one he is working in.
 *
 * It lives HERE, beside the panel's other rules, because two things read it: the ring on a tree row
 * (`attention` in `app.ts`) and the Active list below. It used to be a private const in `app.ts`,
 * and a second copy for the list is exactly the drift the record's "What would make this wrong"
 * names — the same class of bug as items 53 and 63, where two readings of one fact disagreed.
 */
export const ACTIVE_MS = 24 * 60 * 60 * 1000;

/** The one fact the list needs from a session. `SessionActivity` is a superset. */
export interface ActiveSession {
  lastTyped: number;
}

/** One row of the Active list: which record, and when he last typed in it. */
export interface ActiveRow {
  path: string;
  lastTyped: number;
}

/**
 * Which records the Active list draws, newest first.
 *
 * A SECOND READ of `state.activity`, not a second truth: "active" is `lastTyped` inside `ACTIVE_MS`,
 * the identical comparison the ring makes, so a row in this list and a ring on its tree row can
 * never disagree. The only axis applied is the core — User, 2026-08-26: *"show only in selected
 * core. So if it's personal then personal if all then all if work then work"* — and the recency and
 * status folds deliberately are NOT: a finished project he typed in an hour ago is a place he is
 * working in, which is the whole question this list answers.
 */
export function activeRows(
  records: readonly PanelRecord[],
  activity: Readonly<Record<string, readonly ActiveSession[]>>,
  options: { now: number; core?: string | null },
): ActiveRow[] {
  const wanted = options.core ?? null;
  const floor = options.now - ACTIVE_MS;
  const rows: ActiveRow[] = [];
  for (const record of records) {
    if (wanted !== null && record.core !== wanted) continue;
    let lastTyped = 0;
    for (const session of activity[record.path] ?? []) {
      if (session.lastTyped > lastTyped) lastTyped = session.lastTyped;
    }
    if (lastTyped > floor) rows.push({ path: record.path, lastTyped });
  }
  // Recency, then the path — so two records typed in within the same millisecond still come out in
  // one order rather than whichever the scan happened to return, and a redraw cannot shuffle them
  // under the hand about to click one.
  return rows.sort((a, b) => b.lastTyped - a.lastTyped || a.path.localeCompare(b.path));
}
