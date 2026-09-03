/** Work that waits for the transcript to paint, and the timer that stops it waiting forever.
 *
 * Split out of `app.ts` on 2026-08-25. Both `afterTranscript` and `payOwed` reassign the queue and
 * the timer, so they move together with them — the pair is the module, not the two variables.
 */
/**
 * Work that must not race the transcript.
 *
 * Held until the session's first frame is on screen, then run in the order it was asked for. A
 * screen with no session to wait for releases it immediately, and so does the timer below, so
 * nothing here can stay owed.
 */
let owed: (() => void)[] = [];
let owedTimer: ReturnType<typeof setTimeout> | null = null;

export function afterTranscript(work: () => void): void {
  owed.push(work);
  if (owedTimer !== null) return;
  // A destination that never paints — a record with no session, a store that 404s — must not strand
  // the record document that its own page is made of.
  owedTimer = setTimeout(payOwed, 1_500);
}

export function payOwed(): void {
  if (owedTimer !== null) clearTimeout(owedTimer);
  owedTimer = null;
  const queued = owed;
  owed = [];
  for (const work of queued) work();
}
