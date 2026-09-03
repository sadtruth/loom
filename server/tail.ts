/**
 * Byte-offset tailer. Owns ALL the I/O so transcript.ts can stay pure.
 *
 * Two different partial-input problems live here and must not be conflated:
 *   1. a UTF-8 character split across a read boundary  -> TextDecoder in stream mode
 *   2. a JSON line split across a read boundary        -> the parser's line buffer
 * These transcripts contain Cyrillic and emoji, so (1) is not hypothetical.
 */

import { TranscriptParser } from "./transcript.ts";

export interface TailEvent {
  /** "full" means the file shrank (compaction/replacement) and everything was re-read. */
  kind: "append" | "full";
  fromMessage: number;
  fromTouch: number;
}

export class Tailer {
  private offset = 0;
  private decoder = new TextDecoder("utf-8");
  private parser = new TranscriptParser();

  constructor(private readonly path: string) {}

  get transcript(): TranscriptParser {
    return this.parser;
  }

  /**
   * Read whatever is new. Returns null when nothing changed, so a 500ms poll on an idle session
   * costs one stat and no allocation.
   */
  async poll(): Promise<TailEvent | null> {
    const file = Bun.file(this.path);
    const size = file.size;

    if (size < this.offset) {
      this.reset();
      const event = await this.readFrom(0, size, "full");
      return event ?? { kind: "full", fromMessage: 0, fromTouch: 0 };
    }
    if (size === this.offset) return null;

    return this.readFrom(this.offset, size, "append");
  }

  private reset(): void {
    this.offset = 0;
    this.decoder = new TextDecoder("utf-8");
    this.parser = new TranscriptParser();
  }

  private async readFrom(start: number, end: number, kind: TailEvent["kind"]): Promise<TailEvent | null> {
    if (end <= start) return null;
    const fromMessage = this.parser.messageCount;
    const fromTouch = this.parser.touchCount;

    const slice = Bun.file(this.path).slice(start, end);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    this.offset = start + bytes.byteLength;

    // stream:true keeps an incomplete multibyte sequence inside the decoder until its tail arrives.
    this.parser.push(this.decoder.decode(bytes, { stream: true }));

    return { kind, fromMessage: kind === "full" ? 0 : fromMessage, fromTouch: kind === "full" ? 0 : fromTouch };
  }
}

/**
 * Feed a whole buffer through the same byte path the poller uses, in the given chunk sizes.
 * Exists so the byte-split property drives production code rather than a test-only reimplementation.
 */
export function feedChunks(bytes: Uint8Array, splits: readonly number[]): TranscriptParser {
  const parser = new TranscriptParser();
  const decoder = new TextDecoder("utf-8");
  let at = 0;
  const bounded = [...splits].filter((s) => s > 0 && s < bytes.byteLength).sort((a, b) => a - b);
  for (const point of [...bounded, bytes.byteLength]) {
    if (point <= at) continue;
    parser.push(decoder.decode(bytes.subarray(at, point), { stream: true }));
    at = point;
  }
  if (at < bytes.byteLength) parser.push(decoder.decode(bytes.subarray(at), { stream: true }));
  return parser;
}
