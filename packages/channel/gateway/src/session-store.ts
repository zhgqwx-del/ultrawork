import { readFile, writeFile, mkdir, rename, rm } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";

const defaultStorePath = () =>
  join(homedir(), ".ultrawork", "session-map.json");

/**
 * One IM chat's binding to an OpenCode session, plus the metadata the desktop
 * sidebar and the idle-rotation policy both need.
 *
 * v1 was a flat `{ chatId: sessionId }` — no timestamps at all, so neither
 * "which channel is this session from" (the sidebar badge) nor "how long has it
 * been idle" (rotation) was answerable. Both land in v2 so the migration only
 * happens once.
 */
export interface ChannelSessionEntry {
  sessionId: string;
  chatId: string;
  /** dingtalk | wechat | wecom | feishu */
  channelType: string;
  senderId: string;
  senderName: string;
  workspaceDir: string;
  createdAt: number;
  /** Last inbound user message. Only user traffic bumps this — polls, acks and
   *  other system chatter must not, or a chat could never go idle. */
  lastActiveAt: number;
  /** Session this one replaced when it rotated, so the user can get back to it. */
  prevSessionId?: string;
}

interface StoreV2 {
  version: 2;
  entries: Record<string, ChannelSessionEntry>;
}

/**
 * Store key. v1 keyed on chatId alone, so two channels whose user-id spaces
 * collide would share one session. Namespacing by channel type fixes that.
 */
export function sessionKey(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

/**
 * v1 entries carry no channel type, so their key cannot be reconstructed. Rather
 * than drop them — silently severing every live IM conversation's context — they
 * are kept under their bare chatId and looked up as a fallback; the next message
 * from that chat rewrites them under the namespaced key (see `set`). Their
 * lastActiveAt is unknown, so it is stamped at migration: treating them as "just
 * active" risks one stale turn, treating them as ancient would rotate away a
 * conversation the user is in the middle of.
 */
function migrateV1(obj: Record<string, string>): StoreV2 {
  const now = Date.now();
  const entries: Record<string, ChannelSessionEntry> = {};
  for (const [chatId, sessionId] of Object.entries(obj)) {
    if (typeof sessionId !== "string") continue;
    entries[chatId] = {
      sessionId,
      chatId,
      channelType: "",
      senderId: "",
      senderName: "",
      workspaceDir: "",
      createdAt: now,
      lastActiveAt: now,
    };
  }
  return { version: 2, entries };
}

export class SessionStore {
  private entries = new Map<string, ChannelSessionEntry>();
  /**
   * Injectable so tests never touch the real ~/.ultrawork. Resolving the home dir
   * at construction (not at module load) is what makes that possible — an earlier
   * top-level `join(homedir(), …)` could not be redirected by any env stub, and the
   * suite silently overwrote the developer's live session map.
   */
  private readonly path: string;

  constructor(path: string = defaultStorePath()) {
    this.path = path;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      return; // no store yet — first run
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("[SessionStore] Corrupt store, starting empty");
      return;
    }
    const store =
      parsed && typeof parsed === "object" && (parsed as StoreV2).version === 2
        ? (parsed as StoreV2)
        : migrateV1((parsed ?? {}) as Record<string, string>);
    this.entries = new Map(Object.entries(store.entries ?? {}));
  }

  /**
   * Atomic write: a torn session-map costs every IM chat its context. Temp file +
   * rename, as with ports.json (ADR-045).
   *
   * Two things guard concurrency, and both are load-bearing now that every inbound
   * message re-stamps lastActiveAt (so saves fire per-message, not just per-session):
   *  - a UNIQUE temp name. A shared `${path}.tmp` lets two in-flight saves interleave
   *    write/rename and publish a half-written file, which the next load() would read
   *    as corrupt and silently reset to empty — every chat loses its binding at once.
   *  - a serialization chain. Concurrent renames onto the same target otherwise land
   *    in arbitrary order, so the file could end up holding an older snapshot than
   *    one already acknowledged.
   */
  private writeChain: Promise<void> = Promise.resolve();
  private tmpCounter = 0;

  save(): Promise<void> {
    // Snapshot NOW, not when the chain reaches us: the entries map keeps mutating
    // while earlier writes drain, and a later save must not publish an older map.
    const store: StoreV2 = {
      version: 2,
      entries: Object.fromEntries(this.entries),
    };
    const tmp = `${this.path}.${process.pid}.${this.tmpCounter++}.tmp`;

    this.writeChain = this.writeChain
      .catch(() => {}) // a failed write must not poison later ones
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        try {
          await writeFile(tmp, JSON.stringify(store, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
          });
          await rename(tmp, this.path);
        } catch (err) {
          await rm(tmp, { force: true }); // don't litter on a failed rename
          throw err;
        }
      });
    return this.writeChain;
  }

  /** Namespaced key first, bare chatId second (un-migrated v1 entry). */
  get(channelType: string, chatId: string): ChannelSessionEntry | undefined {
    return (
      this.entries.get(sessionKey(channelType, chatId)) ??
      this.entries.get(chatId)
    );
  }

  /** Writes under the namespaced key, retiring any v1 leftover for this chat. */
  set(entry: ChannelSessionEntry): void {
    this.entries.delete(entry.chatId);
    this.entries.set(sessionKey(entry.channelType, entry.chatId), entry);
  }

  delete(channelType: string, chatId: string): void {
    this.entries.delete(sessionKey(channelType, chatId));
    this.entries.delete(chatId);
  }

  list(): ChannelSessionEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}
