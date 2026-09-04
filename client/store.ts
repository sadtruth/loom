/** The client's shared store: the one state object, the one element registry, and the lookup that
 *  builds it.
 *
 * They lived inside `app.ts` until 2026-08-25, and that is the reason app.ts was one 5,841-line
 * module rather than one long file: all 285 of its declarations reached into these two consts
 * directly, so cutting the file anywhere produced two files importing each other. Here, a feature
 * module takes what it needs from a leaf and owes the entry point nothing.
 *
 * `ui` calls `need()` at module load, exactly as it did before — the document is already parsed by
 * the time the entry's module graph evaluates.
 */
import type {
  Artifact,
  ModelSpec,
  PendingEcho,
  Permit,
  Pin,
  ProtoGroup,
  RecapEntry,
  RecordDoc,
  RecordInfo,
  SessionActivity,
  SessionInfo,
  TrainCar,
  BarReading,
} from "./types.ts";
import type { Message } from "./render.ts";
import { newSet as newOpenSet, selected as selectedOpen, type OpenSet } from "./opens.ts";
import type { BudgetsReport } from "./quota-bar.ts";

export const state = {
  models: [] as ModelSpec[],
  activeFamily: "claude" as "claude" | "google",
  /** What the seam is carrying: null until a frame says otherwise. Cleared by the dismiss.
   *  `from` is "ledger" for a block re-read after a restart — it was carried once and never again. */
  recap: null as {
    phase: "running" | "ready" | "failed";
    entry: RecapEntry | null;
    reason: string | null;
    from?: "ledger";
  } | null,
  /** Epoch ms the running recap started, from the SERVER's clock where it is known (181). */
  recapStarted: null as number | null,
  projectKey: "",
  sessionId: "",
  cwd: null as string | null,
  messages: [] as Message[],
  artifacts: [] as Artifact[],
  pins: {} as Record<string, Pin>,
  view: "chat" as "chat" | "document",
  showThinking: false,
  showMeta: false,
  socket: null as WebSocket | null,
  subagents: new Map<string, any>(),
  permits: [] as Permit[],
  job: "idle" as "idle" | "running",
  /** Turns accepted and not yet answered, for the composer hint (SPEC 106). */
  queued: 0,
  /** The act in flight — `reading tasks.ts` — or null before the first frame says (SPEC 96). */
  step: null as string | null,
  /** LOCAL clock reading for when the shown step last changed; the overstay rule counts from it. */
  stepAt: 0,
  records: [] as RecordInfo[],
  /** The entered project record — the workspace context (null = general). */
  activeRecord: null as string | null,
  /** Which core's projects the panel shows. Null = all. Lives in the URL, never on the device. */
  core: null as string | null,
  /** The cores the server declares, with whether each has a vault to run in. */
  cores: [] as { id: string; label: string; usable: boolean }[],
  /** The entered record's split doc: ONE fetch feeding both the centre tab and the right column. */
  recordDoc: null as RecordDoc | null,
  /**
   * Where inside the open file to land — `:120`, `:120-140` or `#a-heading` (link kind 6).
   *
   * It is STATE rather than an argument because it has to survive a reload: `toParams` carries the
   * open set, and the place used to ride glued to the filename, so a restored URL asked the server
   * for a file whose name ended in a line number and got a 400 every time. Null whenever the centre
   * is not a file, so it can never leak into an address that has no file in it.
   */
  filePlace: null as string | null,
  /** Which of the right column's two surfaces the reader pinned; null follows the centre (SPEC 76). */
  drawerPick: null as "tasks" | "protos" | "files" | null,
  /** The prototypes surface's fetch, cached per record — null until first shown. */
  protos: null as { record: string; groups: ProtoGroup[] } | null,
  /**
   * What is open, in order, and which one the centre shows (SPEC 201) — the real state.
   *
   * The open list draws it (SPEC 202): the chat row first and unclosable, one row per record he
   * opened, and — once 189 lands — one per file. `state.centre` reads its selection.
   */
  opens: newOpenSet("chat") as OpenSet,
  /**
   * What the centre shows inside the context — now DERIVED from the open set's selection, so the
   * enum every call site reads cannot drift from the set the list will draw.
   */
  get centre(): "session" | "record" {
    return selectedOpen(state.opens).kind === "session" ? "session" : "record";
  },
  sessions: [] as SessionInfo[],
  /** A composed-but-unsent new session: the next send creates it. */
  pendingNew: false,
  attachments: [] as { mediaType: string; data: string }[],
  /** Attention facts per transcript store, keyed the way the tree keys its rows (SPEC 62). */
  activity: {} as Record<string, SessionActivity[]>,
  /**
   * Record paths the LAST successful `/api/activity` answer actually resolved (SPEC requirement
   * 237). `recordIsNew` reads this, never `activity[path] ?? []` directly — a path missing here is
   * "not asked yet", which must never be read as "asked, and empty".
   */
  activityAnswered: new Set<string>(),
  /** Per device, per session: the newest message timestamp this browser has actually shown. */
  seen: {} as Record<string, number>,
  /** Anything older than this device's first boot counts as read — see SPEC 64. */
  watermark: 0,
  /**
   * Sent, accepted, not yet in the transcript — drawn as ghost turns so a queued message shows.
   * Keyed BY SESSION: a flat list drew the same pale echo in every chat in every project, and in
   * all but the one it was sent to nothing ever arrived to prune it (2026-08-07).
   *
   * The SERVER owns this list (SPEC 138) — every job frame replaces the bucket wholesale, and an
   * attach always sends one. The client used to own it, which is why a reload showed no echo at all:
   * the message was really queued and really being answered, and the only record of it died with the
   * page (2026-08-10).
   */
  pending: {} as Record<string, PendingEcho[]>,
  /**
   * Every send's ACCEPT time, keyed by session — the queue's memory after the queue forgets
   * (SPEC 145). An echo leaves `pending` the moment its message is answered, and the transcript row
   * that replaces it is stamped with PICKUP time, which is later by the whole length of the turn
   * ahead of it. Keeping the accept time is what lets the real row be drawn where the echo stood,
   * so the message does not move when it is answered. Fed by the server on attach and by every
   * job frame; never pruned within a session.
   */
  anchors: {} as Record<string, PendingEcho[]>,
  /** The session a `pendingNew` send created, known before adoption — which bucket is on screen. */
  pendingNewId: null as string | null,
  /** This record's sessions as one line of work, oldest first (SPEC §Train). */
  train: [] as TrainCar[],
  /** Earlier cars the reader pulled in above the seam: session id → its messages. */
  carsOpen: {} as Record<string, Message[]>,
  /** Cars being fetched right now — a second click must not start a second fetch. */
  carsLoading: new Set<string>(),
  /**
   * A draft PER SESSION. Drafts live in `localStorage` locally, and are persisted to the server under
   * `<stateDir>/drafts/<key>.json`. A reload used to lose them, and a second device never saw them;
   * now they survive a reload and follow the user across devices.
   */
  drafts: {} as Record<string, { text: string; at: number }>,
  /** The last `/api/bar` answer — the account's own quota reading, never the fitted estimate
   *  (usage-bar, 2026-08-26). Null until the first poll answers. */
  bar: null as BarReading | null,
  /** The last `/api/budgets` answer — multi-provider quota across all 6 pools. */
  budgets: null as BudgetsReport | null,
};

export function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

export const ui = {
  layout: need<HTMLElement>("layout"),
  coreSelect: need<HTMLSelectElement>("core-select"),
  coreCount: need<HTMLElement>("core-count"),
  fileHead: need<HTMLElement>("file-head"),
  fileTitle: need<HTMLElement>("file-title"),
  filePath: need<HTMLElement>("file-path"),
  fileBody: need<HTMLElement>("file-body"),
  fileEdit: need<HTMLButtonElement>("file-edit"),
  fileSave: need<HTMLButtonElement>("file-save"),
  fileCancel: need<HTMLButtonElement>("file-cancel"),
  status: need<HTMLElement>("status"),
  drawerReopen: need<HTMLButtonElement>("drawer-reopen"),
  chatArea: need<HTMLElement>("chat-area"),
  transcript: need<HTMLElement>("transcript-body"),
  /** The centre COLUMN itself. The composer hangs off it while a record is up (SPEC 199 + 2026-08-12). */
  transcriptPane: need<HTMLElement>("transcript"),
  drawer: need<HTMLElement>("drawer-body"),
  drawerCount: need<HTMLElement>("drawer-count"),
  drawerTasks: need<HTMLButtonElement>("drawer-tasks"),
  drawerProtos: need<HTMLButtonElement>("drawer-protos"),
  drawerFiles: need<HTMLButtonElement>("drawer-files"),
  toast: need<HTMLElement>("toast"),
  composer: need<HTMLFormElement>("composer"),
  composerText: need<HTMLTextAreaElement>("composer-text"),
  composerSend: need<HTMLButtonElement>("composer-send"),
  composerStop: need<HTMLButtonElement>("composer-stop"),
  composerAttach: need<HTMLButtonElement>("composer-attach"),
  attachInput: need<HTMLInputElement>("attach-input"),
  attachments: need<HTMLElement>("attachments"),
  composerAnchor: need<HTMLElement>("composer-anchor"),
  writePill: need<HTMLButtonElement>("write-pill"),
  permitBadge: need<HTMLButtonElement>("permit-badge"),
  gutter: need<HTMLElement>("gutter"),
  tree: need<HTMLElement>("tree-body"),
  activeHead: need<HTMLElement>("active-head"),
  active: need<HTMLElement>("active-body"),
  railToggle: need<HTMLButtonElement>("rail-toggle"),
  updateBar: need<HTMLButtonElement>("update-bar"),
  build: need<HTMLElement>("build"),
  barMeter: need<HTMLElement>("bar-meter"),
  barDot: need<HTMLElement>("bar-dot"),
  barPct: need<HTMLElement>("bar-pct"),
  barSep: need<HTMLElement>("bar-sep"),
  barCache: need<HTMLElement>("bar-cache"),
  barReset: need<HTMLElement>("bar-reset"),
  barSep0: need<HTMLElement>("bar-sep0"),
  barCtx: need<HTMLElement>("bar-ctx"),
  microStrip: need<HTMLElement>("micro-strip"),
  mbClaude: need<HTMLElement>("mb-claude"),
  mbG1Gem: need<HTMLElement>("mb-g1-gem"),
  mbG1Cla: need<HTMLElement>("mb-g1-cla"),
  mbJules: need<HTMLElement>("mb-jules"),
  barTip: need<HTMLElement>("bar-tip"),
  composerNew: need<HTMLButtonElement>("composer-new"),
  opens: need<HTMLElement>("opens"),
  recordBody: need<HTMLElement>("record-body"),
  modeCards: need<HTMLInputElement>("mode-cards"),
  useBrowser: need<HTMLInputElement>("use-browser"),
  pickModel: need<HTMLSelectElement>("pick-model"),
  pickEffort: need<HTMLSelectElement>("pick-effort"),
};
