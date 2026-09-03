/** Asking the server for JSON, and abandoning what the last gesture asked for.
 *
 * Split out of `app.ts` on 2026-08-25: `getJson` was called from six sections and the abort
 * controller from two more, none of which was the scrolling code they happened to live in.
 */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal === undefined ? undefined : { signal });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return (await response.json()) as T;
}

/**
 * Everything the CURRENT destination asked for that is not the destination itself.
 *
 * loom's server is one process, so a request that takes 400ms to answer holds the event loop and
 * everything behind it waits — including the socket carrying the session the reader just clicked.
 * Measured 2026-08-23 on User's own store: a click into a project-session cost 2,553ms, and 2,454
 * of them were spent before the socket opened, behind the record document, the train, the block
 * probe and the meter — several of which belonged to the project he had already LEFT. The transcript
 * itself took 124ms once it was asked for. User: *"i keep click back and forth between this
 * project-session and another project-session and its never as fast as 136ms - it's a couple
 * seconds"*.
 *
 * So a gesture abandons the last one's decorations. Nothing here is dropped from the product — the
 * new destination asks for its own, and asks after its transcript rather than in front of it.
 */
let decorations = new AbortController();

/** The signal a decoration fetch must carry to be abandoned when the reader walks on. */
export function decoration(): AbortSignal {
  return decorations.signal;
}

/** Abandon everything the last destination asked for. Called at the start of a gesture. */
export function abandonDecorations(): void {
  decorations.abort();
  decorations = new AbortController();
}
