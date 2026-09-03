/**
 * The image viewer (SPEC §117/§118).
 *
 * An image in the transcript is capped at 560px, which is unreadable for a screenshot or a chart.
 * Clicking one opens it over the page; the wheel or a pinch zooms into the point under the pointer,
 * and a drag pans. Nothing rests on screen — the overlay exists only while it is open.
 *
 * Two decisions worth keeping:
 *
 * ONE LISTENER, NOT THREE. Images are rendered in three unrelated places (a pasted image in
 * `render.ts`, a grid block in `blocks.ts`, the file pane in `filepane.ts`) and the transcript
 * redraws in full on every change, so per-image handlers would be both triplicated and re-attached
 * hundreds of times a session. Instead each site marks its image `.zoomable` and one delegated
 * listener serves all of them, including any site added later.
 *
 * ONE POINTER MODEL. Pointer events carry mouse, pen and touch, so drag and pinch are the same code
 * path at 1440×900 and at 390×844; `wheel` is the only mouse-only addition. Writing a touch path
 * separately is how the phone half rots.
 *
 * The overlay copies the image's `src` rather than moving the node, so a transcript redraw
 * underneath cannot blank what is being looked at.
 */

import {
  clamp,
  clampView,
  fitFrame,
  initialView,
  MAX_SCALE,
  toggleZoom,
  zoomAt,
  zoomRaw,
  type Frame,
  type View,
} from "./zoom-math.ts";

interface Overlay {
  root: HTMLDivElement;
  img: HTMLImageElement;
}

let overlay: Overlay | null = null;
let frame: Frame = { w: 0, h: 0, bw: 0, bh: 0 };
let view: View = { s: 1, x: 0, y: 0 };
/** Live pointers by id — one is a drag, two are a pinch. */
const pointers = new Map<number, { x: number; y: number }>();
/**
 * Where the current gesture started: the view at the moment the finger count last changed, plus the
 * pointers' midpoint and spread then. Every move is computed from HERE rather than from the previous
 * move, and that is not a style choice — the browser delivers a two-finger move as two separate
 * `pointermove` events, so an incremental model spends every pinch acting on a half-updated
 * midpoint and drifts off the fingers a few pixels at a time (caught by the phone pin, 2026-08-08).
 * Recomputing from the start makes each frame an exact function of where the fingers are now.
 */
let gesture: { view: View; x: number; y: number; spread: number } | null = null;
/** Set while a gesture is in flight, so a drag never ends as a "click on the backdrop". */
let moved = false;

function build(): Overlay {
  const root = document.createElement("div");
  root.id = "zoom";
  root.hidden = true;

  const img = document.createElement("img");
  img.id = "zoom-img";
  img.alt = "";
  img.draggable = false;

  const close = document.createElement("button");
  close.id = "zoom-close";
  close.type = "button";
  close.title = "Close (Esc)";
  close.textContent = "×";
  close.addEventListener("click", shut);

  root.append(img, close);
  document.body.append(root);

  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onUp);
  root.addEventListener("dblclick", onDoubleClick);

  return { root, img };
}

function apply(): void {
  if (overlay === null) return;
  overlay.img.style.width = `${frame.bw}px`;
  overlay.img.style.height = `${frame.bh}px`;
  overlay.img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  overlay.root.classList.toggle("zoomed", view.s > 1.01);
  // Read by the pins, and the honest kind of readout: written from the view actually applied above.
  overlay.root.dataset["scale"] = view.s.toFixed(4);
  overlay.root.dataset["x"] = view.x.toFixed(2);
  overlay.root.dataset["y"] = view.y.toFixed(2);
}

/** Measure the window and the image, and go back to fit. Also the resize response. */
function refit(): void {
  if (overlay === null) return;
  const { img, root } = overlay;
  frame = fitFrame(img.naturalWidth, img.naturalHeight, root.clientWidth, root.clientHeight);
  view = initialView(frame);
  apply();
}

export function isOpen(): boolean {
  return overlay !== null && !overlay.root.hidden;
}

export function show(src: string, alt: string): void {
  overlay ??= build();
  const { root, img } = overlay;
  root.hidden = false;
  img.alt = alt;
  if (img.src !== src) {
    img.src = src;
    // Natural size is unknown until it decodes; a cached image is already `complete` here.
    if (!img.complete) img.addEventListener("load", refit, { once: true });
  }
  refit();
}

/**
 * When a TAP last closed the viewer.
 *
 * A tap closes it on `pointerup`, and the browser sends the synthesised CLICK afterwards — by which
 * time the overlay is gone, so that click hits whatever is under the point in the page. When that
 * is a `.zoomable` image, the opener below re-opens the viewer the tap just closed. Found on a
 * phone once the composer joined the scroller (SPEC 199) and moved the transcript's images under
 * the × ; the defect was always there, waiting for a layout that put one behind that corner.
 *
 * Touch only, and matched by POINT as well as by time: a mouse click on the × produces no second
 * click, and a deliberate tap to re-open lands on the image rather than on the corner the viewer
 * was closed from. Guarding by time alone blocks that re-open, which is a worse bug than the one
 * being fixed (measured: it broke re-opening in the same spec).
 */
let tapShutAt = 0;
let tapShutX = 0;
let tapShutY = 0;

export function shut(): void {
  if (overlay === null) return;
  overlay.root.hidden = true;
  pointers.clear();
}

function centre(): { x: number; y: number; spread: number } {
  const live = [...pointers.values()];
  const [a, b] = live;
  if (a === undefined) return { x: 0, y: 0, spread: 0 };
  if (b === undefined) return { x: a.x, y: a.y, spread: 0 };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, spread: Math.hypot(a.x - b.x, a.y - b.y) };
}

/** Re-anchor the gesture to where the fingers are now. Called whenever their number changes. */
function restart(): void {
  if (pointers.size === 0) {
    gesture = null;
    return;
  }
  const now = centre();
  gesture = { view, x: now.x, y: now.y, spread: now.spread };
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  // deltaMode 1 is lines, 2 is pages — a raw deltaY would make a Firefox notch 40× a Chrome one.
  const step = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
  view = zoomAt(view, frame, Math.exp(-step * 0.002), event.clientX, event.clientY);
  apply();
  restart();
}

function onDown(event: PointerEvent): void {
  if (event.target instanceof HTMLButtonElement) return;
  (event.target as Element).setPointerCapture?.(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) moved = false;
  restart();
}

function onMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId) || gesture === null) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const now = centre();
  if (Math.hypot(now.x - gesture.x, now.y - gesture.y) > 2) moved = true;

  // Pinch and drag are one gesture: scale about the fingers' midpoint by how far apart they have
  // moved SINCE THE START, then follow the midpoint. One finger has no spread, so the factor is 1
  // and this is a pure pan.
  const spreading = pointers.size >= 2 && gesture.spread > 0 && now.spread > 0;
  if (spreading) moved = true;
  const wanted = spreading ? now.spread / gesture.spread : 1;
  const granted = clamp(gesture.view.s * wanted, 1, MAX_SCALE) / gesture.view.s;
  const scaled = zoomRaw(gesture.view, granted, gesture.x, gesture.y);
  view = clampView(
    { s: scaled.s, x: scaled.x + (now.x - gesture.x), y: scaled.y + (now.y - gesture.y) },
    frame,
  );
  apply();
}

function onUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  if (pointers.size > 0) {
    // Lifting one finger of two must not jump the image: the remaining one starts a fresh gesture.
    restart();
    return;
  }
  gesture = null;
  // A tap that went nowhere, outside the picture, means "give me the page back".
  if (!moved && event.target !== overlay?.img) {
    if (event.pointerType !== "mouse") {
      tapShutAt = performance.now();
      tapShutX = event.clientX;
      tapShutY = event.clientY;
    }
    shut();
  }
  moved = false;
}

function onDoubleClick(event: MouseEvent): void {
  if (event.target instanceof HTMLButtonElement) return;
  event.preventDefault();
  view = toggleZoom(view, frame, event.clientX, event.clientY);
  apply();
}

/**
 * One delegated listener for every `.zoomable` image, present or future. Installed once at boot.
 */
export function installZoom(): void {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.classList.contains("zoomable")) return;
    if (isOpen()) return;
    // The click that FOLLOWS the tap which closed the viewer must not re-open it: same place, same
    // moment, one gesture. A tap anywhere else is a reader asking for the viewer again.
    const sameGesture =
      performance.now() - tapShutAt < 700 && Math.hypot(event.clientX - tapShutX, event.clientY - tapShutY) < 12;
    if (sameGesture) return;
    event.preventDefault();
    show(target.currentSrc || target.src, target.alt);
  });

  // Capture, and swallowed, so the viewer takes Escape before the wheel and the file pane do.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !isOpen()) return;
      event.stopPropagation();
      shut();
    },
    true,
  );

  window.addEventListener("resize", () => {
    if (isOpen()) refit();
  });
}
