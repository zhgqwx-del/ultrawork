/**
 * Progressive delivery for channels that cannot edit a sent message.
 *
 * None of the four adapters can edit or stream into an existing message (the
 * adapter surface is `sendMessage(chatId, content)` — no message handle), so the
 * only way to show progress is to send finished blocks as separate messages.
 * This is also what Tencent's own WeChat bot does: coalesce until a block is big
 * enough, then send it as a new message.
 *
 * Every channel rate-limits sends (WeCom is the tightest at 30/min per chat) and
 * none of the adapters throttle, so the chunk count per turn is capped: once the
 * budget is spent, the rest is held back for the final flush.
 */

export interface ChunkerOptions {
  /** Hold back a block until it reaches this length (Tencent's own bot uses 200) */
  minChars?: number;
  /** Max blocks streamed mid-turn. The final flush is always allowed on top. */
  maxChunks?: number;
}

const DEFAULT_MIN_CHARS = 200;
const DEFAULT_MAX_CHUNKS = 6;

export class BlockChunker {
  private readonly minChars: number;
  private readonly maxChunks: number;
  /** How much of the full text has already been sent */
  private emitted = 0;
  private chunks = 0;

  constructor(options: ChunkerOptions = {}) {
    this.minChars = options.minChars ?? DEFAULT_MIN_CHARS;
    this.maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
  }

  /** Blocks streamed so far this turn */
  get sent(): number {
    return this.chunks;
  }

  /**
   * Given the full text so far, return the next block ready to send, or null.
   * Cuts only at a paragraph break, and never inside a fenced code block.
   */
  next(fullText: string): string | null {
    if (this.chunks >= this.maxChunks) return null;

    const pending = fullText.slice(this.emitted);
    if (pending.length < this.minChars) return null;

    const cut = this.findCut(fullText);
    if (cut < 0) return null;

    const block = fullText.slice(this.emitted, cut).trim();
    this.emitted = cut;
    if (!block) return null; // whitespace-only: swallow it, but keep the advance

    this.chunks++;
    return block;
  }

  /** Whatever has not been streamed yet */
  rest(fullText: string): string {
    return fullText.slice(this.emitted).trim();
  }

  /**
   * Last paragraph break that is at least `minChars` into the unsent text and
   * sits outside a code fence. Splitting a fence would emit two broken halves.
   */
  private findCut(fullText: string): number {
    const floor = this.emitted + this.minChars;
    let cut = -1;

    for (
      let i = fullText.indexOf("\n\n", this.emitted);
      i !== -1;
      i = fullText.indexOf("\n\n", i + 1)
    ) {
      const boundary = i + 2;
      if (boundary < floor) continue;
      if (isInsideFence(fullText, boundary)) continue;
      cut = boundary;
    }

    return cut;
  }
}

/** A cut point is inside a fence when an odd number of ``` precede it */
function isInsideFence(text: string, index: number): boolean {
  let count = 0;
  let at = text.indexOf("```");
  while (at !== -1 && at < index) {
    count++;
    at = text.indexOf("```", at + 3);
  }
  return count % 2 === 1;
}
