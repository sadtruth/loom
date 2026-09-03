/**
 * When the composer docks, and what else is on screen when it does (SPEC 199, 184).
 *
 * Pure and DOM-free so the decision can be pinned as a property rather than driven. The rule is the
 * prototype's, and it is two terms, not one: CONTENT plus DISTANCE.
 *
 *   docked ⟺ there is a draft AND the composer's own place in the flow has left the viewport
 *
 * The first version of the plan said "the moment it holds a character", which is a different and
 * worse feature: it rips the bar out of the flow and re-lands it as an overlay on the first
 * keystroke of every ordinary message typed at the bottom of the transcript, which is the common
 * case. His rule is about reading UP the page: *"when i start typing something in the input it
 * should be visible when i scroll up, past it."*
 *
 * FOCUS is not part of it. Focus without text is not a draft, and docking on focus would move the
 * bar every time he clicked into it to read what he had already typed.
 */

/**
 * How far past the viewport floor the composer's place must be before it counts as gone.
 *
 * 70px, from the prototype (`mockups/shell-v8-2026-08-11.html`). A margin is needed at all because
 * a composer half on screen is still a composer he can see, and pulling it out from under him at
 * one pixel of overlap is the flicker this rule exists to avoid.
 */
export const DOCK_MARGIN = 70;

export interface DockInput {
  /** The textarea's raw value. */
  text: string;
  /** How many images are attached. An attachment is content: a draft can be a picture and no words. */
  attachments: number;
  /** Whether the textarea has focus. Deliberately NOT part of the decision — see above. */
  focused: boolean;
  /** The spacer's top edge, in viewport coordinates: where the composer sits in the flow. */
  anchorTop: number;
  /** The scroller's bottom edge, in viewport coordinates. */
  viewBottom: number;
  /** The composer's measured height, which the spacer has to hold while it is docked. */
  height: number;
}

export interface DockState {
  docked: boolean;
  /** The `write` pill: the way back to a composer that is empty and out of view (SPEC 184). */
  pill: boolean;
  /** What the spacer must be, in pixels: the composer's height while docked, nothing otherwise. */
  spacer: number;
}

/** Is there a draft at all? Whitespace is not a draft; an attachment with no words is. */
export function written(text: string, attachments: number): boolean {
  return text.trim().length > 0 || attachments > 0;
}

/** Has the composer's place in the flow left the viewport? */
export function away(anchorTop: number, viewBottom: number): boolean {
  return anchorTop > viewBottom - DOCK_MARGIN;
}

/**
 * The whole decision, in one place.
 *
 * The spacer is computed here rather than at the moment of docking, because the composer GROWS:
 * `growTextarea` runs the box up to 40% of the window, and a spacer measured once at dock time
 * diverges from it by every line typed afterwards — which is the lurch 182 exists to prevent.
 */
export function dockState(input: DockInput): DockState {
  const hasDraft = written(input.text, input.attachments);
  const gone = away(input.anchorTop, input.viewBottom);
  const docked = hasDraft && gone;
  return {
    docked,
    // Never together: a draft that has scrolled away is docked, and a docked composer is visible.
    pill: gone && !hasDraft,
    spacer: docked ? Math.max(0, input.height) : 0,
  };
}
