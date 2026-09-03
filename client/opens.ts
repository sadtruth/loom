/**
 * The open set (SPEC 201): the ordered list of things loom has open, and which one the centre shows.
 *
 * Pure and DOM-free on purpose. Before this file the client had no collection at all — `state.centre`
 * was the two-value enum `"session" | "record"` and the tab strip was rebuilt from the ONE active
 * record every redraw, so a second record replaced the first and a file was not in the picture. The
 * list, the per-row close and the file member all need a model underneath them, and the model is
 * worth pinning on its own laws before anything draws it.
 *
 * The laws, stated once and tested in `tests/props/opens.props.test.ts`:
 *   1. No two members share a key.
 *   2. The selected key is always a member's key.
 *   3. The chat member is always present and always first, and `close` cannot remove it.
 *   4. Closing the selected member selects a neighbour — never nothing.
 */

export type OpenKind = "session" | "record" | "file";

export interface OpenMember {
  kind: OpenKind;
  /** Identity, and it is SCOPED BY KIND — build it with `memberKey`. */
  key: string;
  title: string;
}

export interface OpenSet {
  /** Ordered, chat first. */
  members: OpenMember[];
  selected: string;
}

/**
 * A member's identity: the kind, then the path it names.
 *
 * Scoped by kind because `project.md` is routinely open as BOTH — the record, which is the work
 * item surface, and the file, which is the markdown on disk (189 makes a file a member). Keyed by
 * path alone, opening one would silently re-select the other.
 */
export function memberKey(kind: OpenKind, id: string): string {
  return `${kind}:${id}`;
}

/** The path a key names, without its kind. */
export function keyId(key: string): string {
  const at = key.indexOf(":");
  return at < 0 ? key : key.slice(at + 1);
}

/** The chat member's key. One per set: WHICH session it shows is a parameter of that member. */
export const CHAT_KEY = memberKey("session", "chat");

export function chatMember(title = "session"): OpenMember {
  return { kind: "session", key: CHAT_KEY, title };
}

/** A fresh set: the chat, selected, and nothing else. */
export function newSet(title?: string): OpenSet {
  return { members: [chatMember(title)], selected: CHAT_KEY };
}

export function find(set: OpenSet, key: string): OpenMember | undefined {
  return set.members.find((m) => m.key === key);
}

export function isOpen(set: OpenSet, key: string): boolean {
  return find(set, key) !== undefined;
}

/** The member the centre shows. Never undefined: law 2 is what makes that true. */
export function selected(set: OpenSet): OpenMember {
  const member = find(set, set.selected);
  if (member === undefined) throw new Error(`selection ${set.selected} is not a member`);
  return member;
}

/**
 * Add a member without moving the selection, or refresh the title of one already open.
 *
 * Idempotent by key: a record opened twice is one member, and it keeps its PLACE in the order —
 * re-opening is not a reason for a row to jump. The title comes from the newer call, because titles
 * arrive late: a record opened from a link is titled by its path until the scan lands.
 */
export function add(set: OpenSet, member: OpenMember): OpenSet {
  if (member.key === CHAT_KEY) {
    return { ...set, members: set.members.map((m) => (m.key === CHAT_KEY ? { ...m, title: member.title } : m)) };
  }
  if (isOpen(set, member.key)) {
    return { ...set, members: set.members.map((m) => (m.key === member.key ? { ...member } : m)) };
  }
  return { ...set, members: [...set.members, { ...member }] };
}

/** Add and show: the gesture of opening a thing. */
export function open(set: OpenSet, member: OpenMember): OpenSet {
  return select(add(set, member), member.key);
}

/**
 * Open ONE thing beside the chat: the member arrives and every other non-chat member leaves with it
 * (SPEC 196, revising 201).
 *
 * 201 let the set grow, on the reading that a list of open things is what a workspace is. User,
 * looking at it full: *"i dont like how the opened projects accumulate on the right. They sort of
 * create noise. I feel like just opening a project should not leave a permanent mark like that."*
 * So NAVIGATING no longer earns a permanent row — the row is where you are, not where you have been.
 *
 * The set keeps its laws and its shape rather than collapsing back to an enum, because what he
 * asked for next is a DIFFERENT TRIGGER for attaching a thing, not the end of attaching: *"i feel
 * like we should make a different trigger for things to get attached there. So remove that for
 * now."* When that trigger arrives it calls `open`, which is still here and still means "add without
 * displacing", and the set it adds to already knows how to hold many.
 */
export function openOne(set: OpenSet, member: OpenMember): OpenSet {
  let next = set;
  for (const other of set.members) {
    if (other.key === CHAT_KEY || other.key === member.key) continue;
    next = close(next, other.key);
  }
  return open(next, member);
}

/**
 * Open ONE thing beside the chat WITHOUT moving the selection: the ROW appears, the centre does not.
 *
 * The difference from `openOne` is the remaining half of requirement 221. Entering a project must
 * leave its record one click away — a row — while WHICH centre it lands on is decided separately,
 * and usually is not the record. `openOne` selects what it adds, so using it for that row drew the
 * record page on every entry whose destination was not yet known, which is the flash all over again
 * in exactly the case a fixture with warm activity cannot produce. User, 2026-08-20: *"i can still
 * see the project page loading first before the chat when i navigate between projects"*.
 */
export function addOne(set: OpenSet, member: OpenMember): OpenSet {
  let next = set;
  for (const other of set.members) {
    if (other.key === CHAT_KEY || other.key === member.key) continue;
    next = close(next, other.key);
  }
  return add(next, member);
}

/** Show a member that is already open. A key that is not a member changes nothing. */
export function select(set: OpenSet, key: string): OpenSet {
  if (!isOpen(set, key)) return set;
  return { ...set, selected: key };
}

/**
 * Close one member. The chat never closes, and neither does a key that is not open.
 *
 * When the closed member was the one on screen the selection moves to a NEIGHBOUR — the member that
 * takes its index, or the one before it when it was last. It can never land on nothing: the chat is
 * first and unclosable, so anything being closed has something before it.
 */
export function close(set: OpenSet, key: string): OpenSet {
  if (key === CHAT_KEY) return set;
  const at = set.members.findIndex((m) => m.key === key);
  if (at < 0) return set;
  const members = set.members.filter((m) => m.key !== key);
  if (set.selected !== key) return { ...set, members };
  const next = members[at] ?? members[at - 1];
  return { members, selected: next === undefined ? CHAT_KEY : next.key };
}

// ── the URL ─────────────────────────────────────────────────────────

/**
 * The set in the URL, as far as `?record=` + `?session=` can carry it (201's last sentence).
 *
 * Records and files ride as repeated parameters, each kind in its own order; the session id rides
 * as `session`, which is the chat member's parameter rather than a member of its own. What the URL
 * canNOT carry is records interleaved with files, or the titles, or the selection — so a rebuilt
 * set groups the kinds and lands on the chat, which is where a deep link lands today (`boot()`
 * enters the record and then calls `setCentre("session")`).
 */
export function toParams(set: OpenSet, sessionId?: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const member of set.members) {
    if (member.kind === "record") params.append("record", keyId(member.key));
  }
  for (const member of set.members) {
    if (member.kind === "file") params.append("file", keyId(member.key));
  }
  if (sessionId !== undefined && sessionId.length > 0) params.set("session", sessionId);
  return params;
}

/**
 * The core the tab is looking at. Single-valued, so it is a `set` rather than an `append` — and it
 * lives HERE, in the address, rather than in localStorage: a device-wide core is one value two tabs
 * would share, and not sharing it is the whole requirement (User, 2026-08-16).
 */
export function withCore(params: URLSearchParams, core: string | null): URLSearchParams {
  if (core !== null && core.length > 0) params.set("core", core);
  else params.delete("core");
  return params;
}

/** What the URL says this tab's core is, or null for all of them. */
export function coreFromParams(params: URLSearchParams): string | null {
  let core = params.get("core");
  if (core === "lena") core = "spouse"; // leak-ok: legacy id accepted at the read boundary
  return core !== null && core.length > 0 ? core : null;
}

/** The last path segment — the honest title for a member restored from a bare path. */
export function pathTitle(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** Rebuild a set from what the URL carried. Titles fall back to the path's last segment. */
export function fromParams(params: URLSearchParams, titleFor?: (kind: OpenKind, path: string) => string): OpenSet {
  const title = (kind: OpenKind, path: string): string => titleFor?.(kind, path) ?? pathTitle(path);
  let set = newSet();
  for (const kind of ["record", "file"] as const) {
    for (const path of params.getAll(kind)) {
      if (path.length === 0) continue;
      set = add(set, { kind, key: memberKey(kind, path), title: title(kind, path) });
    }
  }
  return set;
}
