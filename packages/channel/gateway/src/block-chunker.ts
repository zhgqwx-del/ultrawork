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
  /**
   * The exact text already sent. NOT an offset: the full text is rebuilt from
   * textParts on every event and it is not append-only — opencode's `text-end`
   * rewrites a part it already published (`trimEnd()`, plus whatever the
   * `experimental.text.complete` plugin returns), which shortens it and shifts
   * every later part left. An absolute index into that string silently ate the
   * next part's opening characters; matching on the sent text does not.
   */
  private sentText = "";
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

    const start = this.consumed(fullText);
    if (fullText.length - start < this.minChars) return null;

    const cut = this.findCut(fullText, start);
    if (cut < 0) return null;

    const block = fullText.slice(start, cut).trim();
    this.sentText = fullText.slice(0, cut);
    if (!block) return null; // whitespace-only: swallow it, but keep the advance

    this.chunks++;
    return block;
  }

  /** Whatever has not been streamed yet */
  rest(fullText: string): string {
    return fullText.slice(this.consumed(fullText)).trim();
  }

  /**
   * Mark the whole text as sent, without a paragraph cut. For the callers that
   * flush the buffer on their own terms (a question is about to go up, the turn
   * errored) — the final flush must not send it a second time.
   */
  consume(fullText: string): void {
    this.sentText = fullText;
  }

  /**
   * Where the unsent text begins. Re-derived every call by matching what we sent
   * against the current full text, so a rewritten (shortened or lengthened)
   * earlier part cannot desynchronise us.
   */
  private consumed(fullText: string): number {
    if (fullText.startsWith(this.sentText)) return this.sentText.length;

    const limit = Math.min(this.sentText.length, fullText.length);
    let i = 0;
    while (i < limit && this.sentText[i] === fullText[i]) i++;
    return i;
  }

  /**
   * Last paragraph break that is at least `minChars` into the unsent text and
   * sits outside a code fence. Splitting a fence would emit two broken halves.
   */
  private findCut(fullText: string, start: number): number {
    const floor = start + this.minChars;
    let cut = -1;

    for (
      let i = fullText.indexOf("\n\n", start);
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
