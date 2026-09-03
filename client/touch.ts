/**
 * Mobile touch gesture controller for narrow viewports (< 900px).
 *
 * Allows swiping left and right from anywhere in the middle of the screen
 * to toggle the left project rail and right drawer without triggering
 * Android's native back edge gestures.
 */

export interface TouchOptions {
  isNarrow: () => boolean;
  openRail: () => void;
  closeRail: () => void;
  isRailOpen: () => boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  isDrawerOpen: () => boolean;
}

export function wireTouchGestures(layout: HTMLElement, options: TouchOptions): () => void {
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let tracking = false;

  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) {
      tracking = false;
      return;
    }
    const touch = e.touches[0];
    if (!touch) return;

    // Do not initiate swipe navigation when touching form inputs or editable elements
    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        tracking = false;
        return;
      }
      if (target.isContentEditable) {
        tracking = false;
        return;
      }
    }

    startX = touch.clientX;
    startY = touch.clientY;
    startTime = Date.now();
    tracking = true;
  }

  function onTouchEnd(e: TouchEvent): void {
    if (!tracking) return;
    tracking = false;

    if (!options.isNarrow()) return;

    const touch = e.changedTouches[0];
    if (!touch) return;

    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const elapsed = Date.now() - startTime;

    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // Filter out vertical scrolling: horizontal movement must exceed threshold and dominate vertical delta
    if (absX < 45 || absX < 1.4 * absY) return;
    // Discard slow drags (over 800ms)
    if (elapsed > 800) return;

    const railOpen = options.isRailOpen();
    const drawerOpen = options.isDrawerOpen();

    if (deltaX > 0) {
      // SWIPE RIGHT (left to right)
      if (drawerOpen) {
        options.closeDrawer();
      } else if (!railOpen) {
        options.openRail();
      }
    } else {
      // SWIPE LEFT (right to left)
      if (railOpen) {
        options.closeRail();
      } else if (!drawerOpen) {
        options.openDrawer();
      }
    }
  }

  function onClick(e: MouseEvent): void {
    if (!options.isNarrow()) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const railOpen = options.isRailOpen();
    const drawerOpen = options.isDrawerOpen();
    if (!railOpen && !drawerOpen) return;

    // If click is inside the open rail/drawer itself or toggle buttons, don't close
    if (
      target.closest("#side") ||
      target.closest("#drawer") ||
      target.closest("#rail-toggle") ||
      target.closest("#drawer-reopen")
    ) {
      return;
    }

    // Clicked in the centre area while a panel is open — dismiss
    if (railOpen) options.closeRail();
    if (drawerOpen) options.closeDrawer();
  }

  function onTouchCancel(): void {
    tracking = false;
  }

  layout.addEventListener("touchstart", onTouchStart, { passive: true });
  layout.addEventListener("touchend", onTouchEnd, { passive: true });
  layout.addEventListener("touchcancel", onTouchCancel, { passive: true });
  layout.addEventListener("click", onClick);

  return () => {
    layout.removeEventListener("touchstart", onTouchStart);
    layout.removeEventListener("touchend", onTouchEnd);
    layout.removeEventListener("touchcancel", onTouchCancel);
    layout.removeEventListener("click", onClick);
  };
}
