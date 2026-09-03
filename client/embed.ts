/**
 * Embedded documents — the one place that knows how to put a FILE on screen (SPEC 165–168).
 *
 * Two consumers: the `iframe` rich block, which has framed prototypes since 2026-08-10, and the
 * plan block, which shows a plan's prototype and its objects' visuals. They cannot import each
 * other — `blocks.ts` owns the registry that draws a plan — so the shared half lives here rather
 * than being written twice and drifting.
 *
 * A frame's height is the FRAMED PAGE'S, never a number in the caller (SPEC 149): the frame has no
 * `allow-same-origin`, so it cannot be measured from outside, and the copy that goes into `srcdoc`
 * carries a few injected lines that post the height up. An image reports nothing at all, so its
 * grower is a `load` handler here — without one, a picture arriving late pushes the text being read
 * (SPEC 155).
 */

const enc = encodeURIComponent;

/**
 * Injected at the END of a framed document: it may not assume a `</body>` exists.
 *
 * NEVER `documentElement.scrollHeight` here (SPEC 214). That number is clamped to the VIEWPORT, so
 * every page shorter than its frame reports the frame's own height back — which meant a frame could
 * only ever be adopted downward, two pixels per round trip, until it happened to strike its
 * content's floor. That walk is what reads as a page in motion when the document fills its window
 * and the floor never arrives; it was also the only way an honest short page's height was ever
 * found, so refusing the report without fixing the measurement froze every prototype at its fence's
 * number. `body.scrollHeight` stays as a floor for content that escapes the root, where an absolute
 * or floated child leaves it behind.
 */
export const MEASURE = `<script>(function(){
  var last = 0;
  function tell(){
    var h = Math.round(document.documentElement.getBoundingClientRect().height);
    if (document.body) h = Math.max(h, document.body.scrollHeight);
    if (h && Math.abs(h - last) > 1) { last = h; parent.postMessage({ loomFrameHeight: h }, "*"); }
  }
  addEventListener("load", tell); addEventListener("resize", tell);
  if (window.ResizeObserver) new ResizeObserver(tell).observe(document.documentElement);
  setTimeout(tell, 0); setTimeout(tell, 200);
})();<\/script>`;

let FRAME_SEQ = 0;

/**
 * Tell the transcript how much taller this just got, so a reader ABOVE it is not pushed down
 * (SPEC 155). `top` is where the growth happened.
 */
function announce(node: HTMLElement, delta: number, top: number): void {
  if (delta <= 0) return;
  node.dispatchEvent(new CustomEvent("loom:block-grew", { bubbles: true, detail: { delta, top } }));
}

/**
 * What each frame has been told, so a report can be recognised as the frame's OWN height coming
 * back (SPEC 214). Weak, so a frame that leaves the document takes its entry with it.
 */
interface FrameHeight {
  /** The last height written to this frame — what an echo will be a hair under. */
  written: number;
  /** The fence gave a number. Without one there is nothing to fall back to but a slab. */
  declared: boolean;
  /** When each revision was made, for the chase detector. */
  revisions: number[];
  /** Settled for good: nothing this document says will be adopted again. */
  frozen: boolean;
  path: string;
}
const HEIGHTS = new WeakMap<HTMLIFrameElement, FrameHeight>();

/**
 * A report this close to what we just wrote is not a measurement (SPEC 214). A document with
 * `html,body{height:100%}` has no height of its own: its root's height IS the frame's height, less
 * the borders of whatever shell it draws, so adopting it produces the next report two pixels
 * smaller, for as long as anyone keeps listening. Four pixels covers a border on each edge without
 * swallowing a change anybody could see.
 */
const ECHO_PX = 4;
/**
 * A frame revising this often is chasing something, whatever the arithmetic behind it.
 *
 * **KNOWN DEFECT, shipped deliberately — the record's item 14 owns it.** A count cannot tell a
 * runaway from an animation: `transition: height .5s` emits a report per animation frame and a page
 * revealing rows on a timer emits one per row, so both trip this bar and are frozen mid-change with
 * their file blamed in the console. Three attempts at a better rule each broke something worse; the
 * measurement it really needs is `iframe-resizer`'s double resize (its issue #733 is this bug), and
 * that is the open item rather than a fourth guess.
 */
const CHASE_LIMIT = 8;
const CHASE_MS = 2000;

/**
 * Where a frame stands while its document loads. 120px was the old one, and a document that never
 * reports an honest height stayed at it — which is the size User turned down (SPEC 214).
 */
const PLACEHOLDER = 360;

/**
 * What a document with no height of its own is given when its fence named no number. User,
 * 2026-08-14, on the placeholder it used to keep: *"120 is too little, i dont like it"*. A share of
 * the pane rather than a constant, because the same prototype is read on a phone.
 */
function slabHeight(): number {
  const pane = document.querySelector<HTMLElement>("#transcript-body");
  const room = pane !== null && pane.clientHeight > 0 ? pane.clientHeight : window.innerHeight;
  return Math.min(720, Math.max(360, Math.round(room * 0.6)));
}

/** Write a height and tell the transcript what moved. */
function setHeight(frame: HTMLIFrameElement, state: FrameHeight, height: number): void {
  const before = frame.getBoundingClientRect();
  frame.style.height = `${String(Math.ceil(height))}px`;
  state.written = Math.ceil(height);
  announce(frame, frame.getBoundingClientRect().height - before.height, before.top);
}

/** One listener for every framed document on the page, installed once. */
if (typeof window !== "undefined") {
  window.addEventListener("message", (event: MessageEvent) => {
    const asked = (event.data ?? {}) as { loomFrameHeight?: unknown };
    const height = typeof asked.loomFrameHeight === "number" ? asked.loomFrameHeight : null;
    if (height === null || height <= 0 || height > 50_000) return;
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe[data-loom-frame]")) {
      if (frame.contentWindow !== event.source) continue;
      const state = HEIGHTS.get(frame);
      if (state === undefined || state.frozen) return;

      // ── the document is reporting the height we just gave it ────────────
      if (Math.abs(height - state.written) <= ECHO_PX) {
        state.frozen = true;
        // Its fence's number is the only real answer for a page that fills whatever it is given;
        // where the fence gave none, a slab it can be read in.
        if (!state.declared) setHeight(frame, state, slabHeight());
        return;
      }

      // ── or chasing by some other arithmetic ─────────────────────────────
      const now = performance.now();
      state.revisions = state.revisions.filter((at) => now - at < CHASE_MS);
      state.revisions.push(now);
      if (state.revisions.length > CHASE_LIMIT) {
        state.frozen = true;
        // Padding on a full-height root reports what it was given PLUS a constant, which walks the
        // frame up to the 50 000px ceiling instead of down to its content. Named, because the fix is
        // in the framed document and nobody could guess which one is doing it.
        console.warn(
          `loom: ${state.path} keeps resizing its own frame (${String(state.revisions.length)} times in ` +
            `${String(CHASE_MS)}ms) — held at ${String(state.written)}px. A framed page must not take ` +
            `its height from the frame (SPEC 214).`,
        );
        return;
      }

      setHeight(frame, state, height);
      return;
    }
  });
}

/** `/api/file`, with the base a relative path resolves against (SPEC 143). */
export function fileUrl(path: string, base: string, raw = false): string {
  const query = [`path=${enc(path)}`];
  if (base.length > 0 && !path.startsWith("/") && !path.startsWith("~")) {
    query.push(`base=${enc(base)}`);
  }
  if (raw) query.push("raw=1");
  return `/api/file?${query.join("&")}`;
}

/**
 * Why a file could not be drawn, in words that say what to DO about it. 413 and 404 are different
 * problems: one tells him to shrink the file, the other sends him looking for it.
 */
export function whyNot(status: number, path: string): string {
  if (status === 413) return `too large to draw here — ${path} is over the 2 MB limit`;
  if (status === 404 || status === 0) return `could not read ${path}`;
  return `could not read ${path} (${String(status)})`;
}

export function embedError(text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "embed-err";
  node.textContent = text;
  return node;
}

/**
 * A sandboxed frame running the page at `path`. `allow-scripts` only: the document may run, and it
 * may not reach the loom API, the cookie, or storage.
 *
 * Under it, the way out (SPEC 205). It points at the same `raw=1` route 137 already serves under
 * `Content-Security-Policy: sandbox allow-scripts`, so the tab is opaque-origin too — no server
 * change, and the frame's stance travels with it.
 *
 * A line UNDER the frame rather than a corner overlay: User, 2026-08-10, over my recommendation
 * of a hover control. Visible at rest, reachable on a phone where nothing hovers, and it costs the
 * frame no room.
 */
export function embedPage(
  path: string,
  base: string,
  startHeight = PLACEHOLDER,
  declared = false,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "embed";
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.dataset["loomFrame"] = String((FRAME_SEQ += 1));
  frame.style.width = "100%";
  frame.style.height = `${String(startHeight)}px`;
  // What it has been told, before it can say anything back (SPEC 214).
  HEIGHTS.set(frame, { written: startHeight, declared, revisions: [], frozen: false, path });
  wrap.append(frame, embedOpen(path, base));
  void fetch(fileUrl(path, base))
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((file: { text: string }) => {
      frame.srcdoc = file.text + MEASURE;
    })
    .catch((error: Error) => {
      // The FRAME failed, not the block. Replacing the wrap's children — which is what this did —
      // took the anchor with it, in the one state where a tab is the only way left to the file.
      frame.replaceWith(embedError(whyNot(Number(error.message) || 0, path)));
    });
  return wrap;
}

/** The anchor on its own, so the frame branch and the error branch cannot drift apart. */
export function embedOpen(path: string, base: string): HTMLAnchorElement {
  const open = document.createElement("a");
  open.className = "embed-open";
  open.href = fileUrl(path, base, true);
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "open in a tab ↗";
  open.title = path;
  return open;
}

/**
 * An image at `path`: as wide as the column, never wider, never enlarged past its own size. It is
 * `.zoomable`, so the viewer loom already has for images in the chat opens it (SPEC 117).
 */
export function embedImage(path: string, base: string, alt = ""): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "embed";
  const img = document.createElement("img");
  img.className = "embed-img zoomable";
  img.alt = alt.length > 0 ? alt : path;
  // `raw=1` is the only way an SVG comes back as an image — `kindOf` keeps it text for the file
  // pane (SPEC 166). For the other six the server answers with the bytes either way.
  img.src = fileUrl(path, base, true);
  img.addEventListener("load", () => {
    const rect = img.getBoundingClientRect();
    announce(img, rect.height, rect.top); // it had no height a moment ago
  });
  img.addEventListener("error", () => {
    // An `img` failure says nothing about WHY, and 413 and 404 need different words, so the reason
    // is asked for once, in the failure path only.
    void fetch(fileUrl(path, base, true))
      .then((res) => wrap.replaceChildren(embedError(whyNot(res.status, path))))
      .catch(() => wrap.replaceChildren(embedError(`could not read ${path}`)));
  });
  wrap.append(img);
  return wrap;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const PAGE = /\.html?$/i;

export type EmbedKind = "image" | "page";

/** Which of the two things a plan may SHOW this path is, or null for anything else (SPEC 165). */
export function embedKind(path: string): EmbedKind | null {
  const clean = path.trim().split(/[?#]/)[0] ?? "";
  if (IMAGE.test(clean)) return "image";
  if (PAGE.test(clean)) return "page";
  return null;
}

/** The picture itself, whichever kind it is; null when the path is neither. */
export function embed(path: string, base: string, alt = ""): HTMLElement | null {
  const kind = embedKind(path);
  if (kind === "image") return embedImage(path, base, alt);
  if (kind === "page") return embedPage(path, base);
  return null;
}
