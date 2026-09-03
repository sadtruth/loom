/**
 * The viewer's geometry (SPEC §117/§118).
 *
 * Pure on purpose: this is where zoom actually goes wrong, and the failure — "zooming drifts away
 * from what I pointed at" — is a relationship between two views, not a value anyone can eyeball in
 * a screenshot. Kept out of the DOM so `tests/props/zoom.props.test.ts` can hunt counterexamples.
 *
 * Coordinates are viewport pixels with the origin at the overlay's top-left. A view renders the
 * image into the rect `[x, x + bw*s] × [y, y + bh*s]`, which is exactly
 * `translate(x px, y px) scale(s)` under `transform-origin: 0 0`.
 */

/** The image's resting size in the window, and the window itself. Fixed for as long as one is open. */
export interface Frame {
  /** Overlay width and height. */
  w: number;
  h: number;
  /** The image at s = 1: contained in the window, never upscaled. */
  bw: number;
  bh: number;
}

export interface View {
  s: number;
  x: number;
  y: number;
}

/** How far past fit the viewer will go. Eight is past the point of usefulness on any real screenshot. */
export const MAX_SCALE = 8;

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Contain, but never enlarge: a 40×40 icon opens at 40×40, not blown up to fill the window. So
 * s = 1 means "fit", and for anything smaller than the window it also means 1:1.
 */
export function fitFrame(natW: number, natH: number, w: number, h: number): Frame {
  const safe = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 1);
  const [nw, nh] = [safe(natW), safe(natH)];
  const scale = Math.min(w / nw, h / nh, 1);
  return { w, h, bw: nw * scale, bh: nh * scale };
}

/** The resting view: fit, centred. */
export function initialView(frame: Frame): View {
  return clampView({ s: 1, x: 0, y: 0 }, frame);
}

/**
 * Keep the image where it can be seen. Bigger than the window on an axis → its edges may not come
 * inside the window; smaller → it is centred, which is also what locks panning at fit (§118).
 */
export function clampView(view: View, frame: Frame): View {
  const rw = frame.bw * view.s;
  const rh = frame.bh * view.s;
  return {
    s: view.s,
    x: rw >= frame.w ? clamp(view.x, frame.w - rw, 0) : (frame.w - rw) / 2,
    y: rh >= frame.h ? clamp(view.y, frame.h - rh, 0) : (frame.h - rh) / 2,
  };
}

/**
 * Scale about (px, py) with nothing else applied. The one rule the whole feature rests on: the
 * image point under the pointer is a FIXED POINT of this map, so a wheel notch or a pinch magnifies
 * what you aimed at rather than the middle of the screen.
 */
export function zoomRaw(view: View, factor: number, px: number, py: number): View {
  return {
    s: view.s * factor,
    x: px - (px - view.x) * factor,
    y: py - (py - view.y) * factor,
  };
}

/** Where a window point lands in the image's own pixels. The quantity `zoomRaw` must preserve. */
export function toImage(view: View, px: number, py: number): { ix: number; iy: number } {
  return { ix: (px - view.x) / view.s, iy: (py - view.y) / view.s };
}

/**
 * A wheel notch or a pinch step: scale bounded to [1, MAX_SCALE] first, so the anchoring is applied
 * to the factor actually granted — scaling by the requested amount and clamping afterwards is what
 * makes a viewer creep sideways when you keep scrolling at the limit.
 */
export function zoomAt(view: View, frame: Frame, factor: number, px: number, py: number): View {
  const granted = clamp(view.s * factor, 1, MAX_SCALE) / view.s;
  return clampView(zoomRaw(view, granted, px, py), frame);
}

/** Drag. At fit this is a no-op, because `clampView` centres anything smaller than the window. */
export function panBy(view: View, frame: Frame, dx: number, dy: number): View {
  return clampView({ s: view.s, x: view.x + dx, y: view.y + dy }, frame);
}

/** The double-click / double-tap toggle: at rest go in to 1:1-ish, otherwise back to fit. */
export function toggleZoom(view: View, frame: Frame, px: number, py: number): View {
  if (view.s > 1.01) return initialView(frame);
  return zoomAt(view, frame, 2.5, px, py);
}
