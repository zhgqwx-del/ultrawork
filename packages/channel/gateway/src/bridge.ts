import { OpenCodeBackend, UNLIMITED_SSE_RETRY, type Unsubscribe } from "@agent/connector";
import type { ApiClient, MessagePart, QuestionInfo } from "@agent/api-client";
import type { IncomingMessage } from "./types.js";
import {
  SessionStore,
  sessionKey,
  type ChannelSessionEntry,
} from "./session-store.js";
import {
  parseAnswer,
  renderQuestions,
  QUESTION_SKIP_COMMAND,
} from "./question-prompt.js";
import { BlockChunker } from "./block-chunker.js";
import { degradeMathToUnicode } from "./math-unicode.js";

// Base URL is injected by the Tauri host alongside the password — opencode's
// port is chosen at startup, not compile time. The fallback keeps a standalone
// gateway (tests, `bun run` against a hand-started opencode) working.
// Lazy, same as the password: tests may set the env after importing this module.
export function getOpencodeBaseUrl(): string {
  return process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
}

// Password is injected by the Tauri host (lib.rs spawns channel-gateway with
// OPENCODE_SERVER_PASSWORD set to the per-install random credential). Lazy
// lookup so tests can import this module without setting the env var.
function getOpencodePassword(): string {
  const pw = process.env.OPENCODE_SERVER_PASSWORD;
  if (!pw) {
    throw new Error(
      "OPENCODE_SERVER_PASSWORD is not set — the Tauri host must spawn channel-gateway with this env var",
    );
  }
  return pw;
}
const MAX_REPLY_LENGTH = 20_000; // Safe limit for messaging platforms (DingTalk, WeChat, etc.)
const EMPTY_REPLY_NOTICE = "✅ 处理完成，但本轮没有产生文本回复。";
const POLL_INTERVAL_MS = 3_000; // Permission/question poll interval
const IDLE_TIMEOUT_MS = 180_000; // 3 min — force-send if idle event missed
const POLL_MAX_LIFETIME_MS = 300_000; // 5 min — auto-stop polling even if session stuck
// A question blocks inside tool execution, so the session stays busy and emits
// nothing at all until it is answered (verified against a real opencode server:
// 195s of silence, zero events). Every other timer here treats silence as a
// stuck turn, so the pending state has to suspend them — and it needs a bound of
// its own, or an unanswered question would pin the session busy forever.
const QUESTION_TIMEOUT_MS = 1_800_000; // 30 min — then auto-reject and tell the user
// The ack exists because a turn used to be silent until it finished. Now that
// finished blocks stream out, it is only worth sending when the agent is slow to
// produce the first one — otherwise it just duplicates a reply that is moments away.
const ACK_DELAY_MS = 2_500;
const ACK_TEXT = "⏳ 收到，正在处理";

/**
 * Idle rotation (ADR-051). An IM chat has no threads, so nothing ever marks the
 * end of a task: without this, one WeChat conversation reuses a single opencode
 * session forever, and last month's debugging noise keeps getting re-fed into
 * today's prompt (cc-connect calls this "context drift" and defaults to 30min;
 * OpenClaw defaults to 60min and gives DMs 240min).
 *
 * 60min by default: our agents run long tasks, and a user who submits one, walks
 * away for half an hour and comes back to ask a follow-up is doing something
 * completely normal — 30min would cut that conversation in half.
 *
 * Set to 0 to disable. The clock is `lastActiveAt`, which only messages we ACT on
 * bump (see touchSession) — polls, acks and turned-away bystanders must not, or a
 * chat would never fall idle.
 */
const DEFAULT_IDLE_ROTATE_MS = 60 * 60_000;

export function getIdleRotateMs(): number {
  const raw = process.env.ULTRAWORK_CHANNEL_IDLE_ROTATE_MS;
  if (raw === undefined) return DEFAULT_IDLE_ROTATE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_ROTATE_MS;
}

/** Channel type → display label mapping */
const CHANNEL_LABELS: Record<string, string> = {
  dingtalk: "钉钉",
  wechat: "微信",
  wecom: "企业微信",
  feishu: "飞书",
};

interface SessionContext {
  sessionId: string;
  chatId: string;
  workspaceDir: string;
  /**
   * Who sent the message that started this turn. A group chat maps to ONE chatId
   * (`group:{conversationId}`) and therefore one session, so this is the only way
   * to tell the person the agent is waiting on from everyone else talking.
   */
  senderId: string;
  senderName: string;
  channelType: string;
  /** Accumulated text per partID (handles multiple text parts) */
  textParts: Map<string, string>;
  /**
   * IDs of assistant messages in this turn. opencode broadcasts part.updated for
   * the *user's* parts too (prompt.ts) — including synthetic ones it injects —
   * so a part is only ours if its messageID is in here.
   */
  assistantMessageIds: Set<string>;
  /**
   * partIDs known to be assistant text. The delta event carries no part type and
   * reasoning-delta uses the same `field: "text"` as text-delta (processor.ts),
   * so deltas can only be attributed via the type learned from part.updated.
   */
  textPartIds: Set<string>;
  /** Callback to reply to the originating message */
  reply: (content: string) => Promise<void>;
  /** Optional: typing indicator callback */
  onTyping?: (typing: boolean) => void;
  /** Idle timeout handle — force-sends accumulated text if SSE misses idle event */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Set while the agent is blocked on a question and we're awaiting the user's reply */
  pendingQuestion?: PendingQuestion;
  /**
   * Questions already answered/rejected this turn. The poll's listQuestions()
   * response can be computed server-side before our reply lands, so it still
   * lists a question we just resolved — re-asking it would strand the user's
   * next message on a request opencode no longer knows about.
   */
  resolvedQuestionIds: Set<string>;
  /** Splits the reply into blocks that can be sent as the turn progresses */
  chunker: BlockChunker;
  /** Pending "still working" ack — cancelled if output arrives first */
  ackTimer?: ReturnType<typeof setTimeout>;
  /** Whether anything at all has been sent to the user this turn */
  saidSomething: boolean;
  /**
   * Serialises outbound sends. Adapter `reply` is a bare HTTP POST; firing
   * several concurrently lets the channel receive them out of order. One message
   * per turn made that harmless — a reply split across blocks does not.
   */
  sendChain: Promise<void>;
}

interface PendingQuestion {
  id: string;
  questions: QuestionInfo[];
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Bridge between channel adapters and OpenCode Server.
 * - Maps chatId → OpenCode session
 * - Sequential queue per chat to prevent concurrent prompts
 * - SSE subscription to collect assistant output and reply on idle
 * - Auto-approves permission (once); forwards questions to the user and waits
 * - Idle timeout fallback in case SSE misses the idle event
 */
export class Bridge {
  /** (channelType, chatId) → OpenCode session + metadata, persisted */
  private store = new SessionStore();
  /** sessionId → active context for current turn */
  private activeContexts = new Map<string, SessionContext>();
  /** sessionKey(channelType, chatId) → sequential promise chain */
  private queues = new Map<string, Promise<void>>();
  /** Per-workspace OpenCode backend (ApiClient + global SSE, via @agent/connector) */
  private backends = new Map<string, OpenCodeBackend>();
  /** Global-stream subscriptions per workspace */
  private sseSubscriptions = new Map<string, Unsubscribe>();
  /** Permission/question poll timers per workspace */
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();

  /** Restore persisted session mappings from disk */
  async init(): Promise<void> {
    await this.store.load();
    if (this.store.size > 0) {
      console.log(`[Bridge] Restored ${this.store.size} session mappings`);
    }
    // Print the policy that is actually in force. The threshold comes from the env,
    // which reaches this process only if the Tauri host passed it through — without
    // this line, "rotation didn't fire" and "the env never arrived" look identical.
    const rotate = getIdleRotateMs();
    console.log(
      `[Bridge] Idle rotation: ${rotate > 0 ? `${Math.round(rotate / 60_000)}min (${rotate}ms)` : "DISABLED"}`,
    );
  }

  /** Persist session map to disk (fire-and-forget) */
  private persistSessionMap(): void {
    this.store.save().catch((err) => {
      console.error("[Bridge] Failed to persist session map:", err);
    });
  }

  /** Channel sessions with metadata — read by the desktop sidebar (badge + unread). */
  listChannelSessions(): ChannelSessionEntry[] {
    return this.store.list();
  }

  /**
   * Retire the idle session so the next prompt starts clean, and TELL the user.
   *
   * The old session is not deleted — it stays in the desktop sidebar, and
   * `prevSessionId` keeps it one `/resume` away. Nothing is carried across:
   * OpenClaw is explicit that a reset starts empty and that continuity is what
   * compaction is for, and cc-connect does the same (old sessions stay reachable
   * via /list + /switch). Auto-summarising into the new session would quietly
   * re-import the very drift the rotation exists to shed.
   */
  /**
   * Swap the chat back to the session it rotated away from. The swap is symmetric —
   * the session being left becomes the new `prevSessionId` — so /resume toggles and
   * a user who resumes by mistake can get back without losing anything.
   */
  private async resumeSession(msg: IncomingMessage): Promise<void> {
    const entry = this.store.get(msg.channelType, msg.chatId);
    const target = entry?.prevSessionId;
    if (!entry || !target) {
      await msg.reply("ℹ️ 没有可恢复的上一个会话。").catch(() => {});
      return;
    }

    // The old session may have been deleted from the desktop in the meantime.
    // Verify before switching, or the next prompt would 404 and silently mint yet
    // another session — leaving the user certain /resume had worked.
    try {
      await this.getClient(entry.workspaceDir || msg.workspaceDir).getSession(target);
    } catch {
      this.store.set({ ...entry, prevSessionId: undefined });
      this.persistSessionMap();
      await msg.reply("⚠️ 上一个会话已不存在（可能已在桌面端删除），无法恢复。").catch(() => {});
      return;
    }

    // Don't strand a turn that is still running on the session we are leaving.
    if (this.activeContexts.has(entry.sessionId)) {
      await msg.reply("⏳ 当前会话还在处理中，请等它结束后再 /resume。").catch(() => {});
      return;
    }

    this.store.set({
      ...entry,
      sessionId: target,
      prevSessionId: entry.sessionId,
      lastActiveAt: Date.now(),
    });
    this.persistSessionMap();
    console.log(`[Bridge] Resumed ${target} for chat ${msg.chatId}`);
    await msg
      .reply("↩️ 已切回上一个会话，可以接着之前的上下文继续。\n再次回复 /resume 可切换回来。")
      .catch(() => {});
  }

  private async announceRotation(
    msg: IncomingMessage,
    entry: ChannelSessionEntry,
    idleMs: number,
  ): Promise<void> {
    console.log(
      `[Bridge] Rotating ${entry.sessionId} for chat ${msg.chatId} ` +
        `(idle ${Math.round(idleMs / 60_000)}min)`,
    );
    await msg
      .reply(
        "🆕 已闲置较久，为你开启新会话（上文不再延续）。\n回复 /resume 可切回上一个会话。",
      )
      .catch(() => {});
  }

  /**
   * Mark this chat active. Only messages we actually ACT on call this — acks,
   * polls and other system chatter must not, or a chat would never go idle (P1).
   * Nor does a bystander whose message we turned away during someone else's
   * pending question: it never reached the agent, and letting it count would let
   * anyone in a group keep a dead session alive forever.
   *
   * Deliberately does not touch senderId/senderName: in a group everyone shares one
   * chatId, and re-writing them per message would make the sidebar badge name
   * whoever spoke last rather than the person the session belongs to. Identity is
   * set once, when the session is created.
   *
   * No-op before the session exists — startTurn writes the first entry.
   */
  private touchSession(msg: IncomingMessage): void {
    const entry = this.store.get(msg.channelType, msg.chatId);
    if (!entry) return;
    this.store.set({
      ...entry,
      chatId: msg.chatId,
      channelType: msg.channelType,
      // A migrated v1 entry carries no workspace; backfill it on first sight.
      workspaceDir: entry.workspaceDir || msg.workspaceDir,
      senderId: entry.senderId || msg.senderId,
      senderName: entry.senderName || msg.senderName,
      lastActiveAt: Date.now(),
    });
    this.persistSessionMap();
  }

  /** Get or create the OpenCode backend for a workspace directory */
  private getBackend(workspaceDir: string): OpenCodeBackend {
    let backend = this.backends.get(workspaceDir);
    if (!backend) {
      backend = new OpenCodeBackend({
        baseUrl: getOpencodeBaseUrl(),
        username: "opencode",
        password: getOpencodePassword(),
        workingDirectory: workspaceDir,
        // IM gateways must never give up: retry forever, capped at 30s
        sse: { retry: UNLIMITED_SSE_RETRY },
      });
      this.backends.set(workspaceDir, backend);
    }
    return backend;
  }

  /** The opencode REST surface for a workspace (same ApiClient as ever) */
  private getClient(workspaceDir: string): ApiClient {
    return this.getBackend(workspaceDir).api;
  }

  /**
   * Should this chat's next message start a FRESH session?
   *
   * Must be asked BEFORE touchSession stamps lastActiveAt — afterwards the chat
   * always looks active and nothing would ever rotate.
   *
   * The in-flight guard is the one that matters. A pending question blocks inside
   * tool execution: the session stays busy and emits NOTHING at all until it is
   * answered (ADR-050 measured 195s of total silence against a real opencode
   * server), and QUESTION_TIMEOUT_MS lets that run 30 minutes. Rotating on a
   * lastActiveAt that old would swap the session out from under the exchange the
   * agent is blocked on — the user answers, and the answer lands on a question that
   * no longer exists. Hermes ships the same rule: never auto-reset a session with
   * work in flight.
   */
  private shouldRotate(entry: ChannelSessionEntry): boolean {
    const threshold = getIdleRotateMs();
    if (threshold <= 0) return false; // disabled
    if (this.activeContexts.has(entry.sessionId)) return false; // turn / question in flight
    return Date.now() - entry.lastActiveAt >= threshold;
  }

  /** Enqueue a task per chatId to prevent concurrent prompts */
  private enqueue(chatId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      // Clean up queue entry if this is the last task in the chain
      if (this.queues.get(chatId) === next) {
        this.queues.delete(chatId);
      }
    });
    this.queues.set(chatId, next);
    return next;
  }

  /** Process an incoming message from a channel adapter */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    // Serialize per (channel, chat) — not per chatId. Two channels whose user-id
    // spaces collide would otherwise block each other's turns.
    await this.enqueue(sessionKey(msg.channelType, msg.chatId), () =>
      this.processMessage(msg),
    );
  }

  private async processMessage(msg: IncomingMessage): Promise<void> {
    // Handle /new command — reset session for this chat
    if (msg.text.trim() === "/new") {
      const old = this.store.get(msg.channelType, msg.chatId);
      if (old) {
        // Clean up any active context for the old session
        const oldCtx = this.activeContexts.get(old.sessionId);
        if (oldCtx) {
          this.clearIdleTimer(oldCtx);
          this.clearAck(oldCtx);
          if (oldCtx.pendingQuestion) {
            // Don't leave the agent blocked on a question nobody will answer
            this.resolvePendingQuestion(oldCtx, (pending) =>
              this.getClient(oldCtx.workspaceDir).rejectQuestion(pending.id),
            );
          }
          this.activeContexts.delete(old.sessionId);
        }
      }
      this.store.delete(msg.channelType, msg.chatId);
      this.persistSessionMap();
      await msg.reply("✅ 已重置对话，下条消息将开启新会话").catch(() => {});
      return;
    }

    // /resume — go back to the session idle rotation retired. This is the escape
    // hatch that makes rotation safe to ship: without it, "改一下刚才那个方案" after
    // an overnight gap reaches an agent with no idea what 刚才 was, and no way back.
    if (msg.text.trim() === "/resume") {
      await this.resumeSession(msg);
      return;
    }

    // If the agent is blocked on a question, this message is the answer — not a
    // new prompt. opencode keeps the session busy while a question is pending,
    // so sending it as a prompt would just come back as BusyError.
    const activeSessionId = this.store.get(msg.channelType, msg.chatId)?.sessionId;
    const activeCtx = activeSessionId
      ? this.activeContexts.get(activeSessionId)
      : undefined;
    if (activeCtx?.pendingQuestion) {
      // In a group everyone shares this chatId. Only the person the agent is
      // waiting on may answer — otherwise unrelated chatter becomes the answer.
      if (msg.senderId !== activeCtx.senderId) {
        await msg
          .reply(
            `⏳ 正在等待 ${activeCtx.senderName} 回答上一个问题，稍后再来。`,
          )
          .catch(() => {});
        return; // turned away — NOT activity, see touchSession
      }
      // Answering never reaches startTurn, so the stamp has to happen here too. A
      // user can sit inside one question for many minutes (QUESTION_TIMEOUT_MS is
      // 30min); if that did not count as activity, idle rotation (P1) would swap the
      // session out from under the very exchange it is blocked on.
      this.touchSession(msg);
      await this.answerPendingQuestion(activeCtx, msg);
      return;
    }

    // Decide rotation BEFORE touchSession — it is about to stamp lastActiveAt, and
    // after that this chat can never look idle again.
    const entry = this.store.get(msg.channelType, msg.chatId);
    const idleMs = entry ? Date.now() - entry.lastActiveAt : 0;
    const rotating = entry ? this.shouldRotate(entry) : false;

    this.touchSession(msg);

    if (rotating && entry) {
      // Say so. The whole risk of rotation is a silent context cut: the user comes
      // back the next morning, says "改一下刚才那个方案", and gets an agent with no
      // idea what 刚才 was. Tell them, and give them a way back.
      await this.announceRotation(msg, entry, idleMs);
    }

    // Hold the ack briefly. Blocks now stream out as the agent produces them, so
    // if the first one lands quickly the ack is cancelled unsent and the user
    // sees real content instead of a placeholder followed by the same answer.
    const ackTimer = setTimeout(() => {
      msg.reply(ACK_TEXT).catch((err) => {
        console.error(`[Bridge] Ack failed for ${msg.chatId}:`, err);
      });
    }, ACK_DELAY_MS);
    // Everything from here to the moment ctx owns this timer can throw (missing
    // password, opencode down, 401). Without this the user would get a lone
    // "still working" 2.5s later and never hear anything again.
    let ackOwned = false;
    try {
      await this.startTurn(
        msg,
        ackTimer,
        () => {
          ackOwned = true;
        },
        rotating ? entry?.sessionId : undefined,
      );
    } finally {
      if (!ackOwned) clearTimeout(ackTimer);
    }
  }

  /** The body of processMessage once the ack timer is armed */
  private async startTurn(
    msg: IncomingMessage,
    ackTimer: ReturnType<typeof setTimeout>,
    onAckOwned: () => void,
    /** Set when this chat rotated: the session being retired, kept for /resume. */
    rotatedFrom?: string,
  ): Promise<void> {
    const client = this.getClient(msg.workspaceDir);

    // Get or create session for this chat
    const existing = this.store.get(msg.channelType, msg.chatId);
    // Rotating: drop the binding so the branch below mints a fresh session. The
    // retired one is NOT deleted — it stays in the desktop sidebar and one /resume
    // away. The store is only rewritten once the new session actually exists, so a
    // failed createSession leaves the chat on its old session rather than stranded.
    let sessionId = rotatedFrom ? undefined : existing?.sessionId;
    if (sessionId) {
      // Validate that the cached session still exists on the server
      try {
        await client.getSession(sessionId);
      } catch {
        console.log(
          `[Bridge] Session ${sessionId} is stale (not found on server), creating new session for chat ${msg.chatId}`,
        );
        // Clean up old active context if any
        const oldCtx = this.activeContexts.get(sessionId);
        if (oldCtx) {
          this.clearIdleTimer(oldCtx);
          this.clearAck(oldCtx);
          // The session is gone server-side; answering its question is moot, but
          // the timer would still fire and message the user about a dead turn.
          if (oldCtx.pendingQuestion) {
            clearTimeout(oldCtx.pendingQuestion.timer);
            oldCtx.pendingQuestion = undefined;
          }
          this.activeContexts.delete(sessionId);
        }
        sessionId = undefined;
      }
    }

    if (!sessionId) {
      const session = await client.createSession({});
      sessionId = session.id;
      const now = Date.now();
      this.store.set({
        sessionId,
        chatId: msg.chatId,
        channelType: msg.channelType,
        // Whoever opened the session owns it. In a group this is deliberately NOT
        // re-written by later speakers (see touchSession) — the badge names the
        // session's owner, matching the "[钉钉·张三]" prefix patched into the title.
        senderId: msg.senderId,
        senderName: msg.senderName,
        workspaceDir: msg.workspaceDir,
        createdAt: now,
        lastActiveAt: now,
        // Only a rotation leaves a way back. A session replaced because the old one
        // 404'd server-side has nothing to resume TO.
        prevSessionId: rotatedFrom,
      });
      this.persistSessionMap();
      console.log(
        `[Bridge] Created session ${sessionId} for chat ${msg.chatId}`,
      );
    }

    // A turn may still be running — most naturally right after the user answered
    // a question and immediately added a remark. opencode queues the new prompt
    // (verified: prompt_async returns 204 mid-turn), so the context must be
    // REUSED, not replaced: a fresh one would have empty assistantMessageIds and
    // a reset chunker, and the running turn's remaining output would be dropped
    // on the floor as "not ours".
    const inFlight = this.activeContexts.get(sessionId);
    const ctx: SessionContext = inFlight ?? {
      sessionId,
      chatId: msg.chatId,
      workspaceDir: msg.workspaceDir,
      senderId: msg.senderId,
      senderName: msg.senderName,
      channelType: msg.channelType,
      textParts: new Map(),
      assistantMessageIds: new Set(),
      textPartIds: new Set(),
      chunker: new BlockChunker(),
      resolvedQuestionIds: new Set(),
      saidSomething: false,
      sendChain: Promise.resolve(),
      reply: msg.reply,
      onTyping: msg.onTyping,
    };

    if (inFlight) {
      // Later output belongs to whoever spoke last (matters in a group chat)
      ctx.senderId = msg.senderId;
      ctx.senderName = msg.senderName;
      ctx.reply = msg.reply;
      ctx.onTyping = msg.onTyping;
      this.clearAck(ctx);
    }
    ctx.ackTimer = ackTimer;
    onAckOwned();
    this.activeContexts.set(sessionId, ctx);

    // Ensure SSE is connected for this workspace and WAIT for it to be ready
    await this.ensureSSE(msg.workspaceDir);

    // Start permission/question polling
    this.ensurePolling(msg.workspaceDir, sessionId);

    // Get current model from server config so channel uses the same model as desktop
    let model: string | undefined;
    try {
      const config = await client.getConfig();
      if (config.model) model = config.model;
    } catch {
      // Fall through — send without model override
    }

    // Start typing indicator
    ctx.onTyping?.(true);

    // Send the prompt
    try {
      // IM sessions are never orchestration Leaders — deny the delegate MCP
      // tools unconditionally (017 拍板 #4 isolation closure).
      await client.promptAsync(sessionId, msg.text, {
        model,
        tools: { "orchestrator_*": false },
      });
      console.log(
        `[Bridge] Sent prompt to session ${sessionId}: "${msg.text.slice(0, 50)}..."`,
      );

      // Start idle timeout — force-send if SSE misses the idle event
      this.startIdleTimer(sessionId);
    } catch (err) {
      console.error(`[Bridge] promptAsync failed for ${sessionId}:`, err);
      this.clearAck(ctx);
      await msg
        .reply(`Error: Failed to send message to AI agent.`)
        .catch(() => {});
      // Only tear the turn down if this message started it. If a turn was
      // already running, it still owns this context and its output is still
      // coming — dropping it here would lose the reply the user is waiting for.
      if (!inFlight) {
        this.clearIdleTimer(ctx);
        ctx.onTyping?.(false);
        this.activeContexts.delete(sessionId);
      }
    }
  }

  /** Cancel the "still working" ack — it is only for turns that stay silent */
  private clearAck(ctx: SessionContext): void {
    if (ctx.ackTimer) {
      clearTimeout(ctx.ackTimer);
      ctx.ackTimer = undefined;
    }
  }

  /**
   * Send content to the chat. Any real output makes the pending ack redundant —
   * cancel it rather than let a "still working" note trail the answer itself.
   */
  private send(ctx: SessionContext, text: string): void {
    this.clearAck(ctx);
    ctx.saidSomething = true;
    // Degrade LaTeX here rather than in each adapter (ADR-070 P2, the same
    // "sanitising lives in bridge.ts" rule discussions/033 P0 set): not one of
    // the four channels renders math, so a formula that the desktop shows as
    // typeset would arrive as source code everywhere. Failure is a no-op — an
    // unparseable span comes back untouched, which is exactly today's output.
    const degraded = degradeMathToUnicode(text);
    // Every outbound message passes through here, so the platform cap is enforced
    // in one place. Streamed blocks need it as much as the final flush does: a
    // single 25k-char paragraph is a valid block, and the channels reject or
    // silently truncate anything over their limit. Applied AFTER degradation:
    // capping first could cut a span between its two `$`, leaving the head as
    // raw LaTeX that no longer parses.
    const safe =
      degraded.length > MAX_REPLY_LENGTH
        ? degraded.slice(0, MAX_REPLY_LENGTH) + "\n\n...(truncated)"
        : degraded;
    const reply = ctx.reply;
    ctx.sendChain = ctx.sendChain.then(() =>
      reply(safe).catch((err) => {
        console.error(`[Bridge] Reply failed for ${ctx.chatId}:`, err);
      }),
    );
  }

  /**
   * Send text and mark it consumed, so the final flush will not repeat it.
   * (`next()` only advances the chunker at a paragraph cut; this forces it.)
   */
  private sendRemainder(ctx: SessionContext, text: string): void {
    const full = Array.from(ctx.textParts.values()).join("\n\n");
    ctx.chunker.consume(full);
    this.send(ctx, text);
  }

  /** Emit any finished block the agent has produced since the last one */
  private streamReadyBlocks(ctx: SessionContext): void {
    // A question is on screen and the user is answering it — do not interleave.
    if (ctx.pendingQuestion) return;

    for (;;) {
      const full = Array.from(ctx.textParts.values()).join("\n\n");
      const block = ctx.chunker.next(full);
      if (!block) return;
      this.send(ctx, block);
    }
  }

  /** Start or reset the idle timeout for a session */
  private startIdleTimer(sessionId: string): void {
    const ctx = this.activeContexts.get(sessionId);
    if (!ctx) return;

    this.clearIdleTimer(ctx);
    ctx.idleTimer = setTimeout(() => {
      console.log(
        `[Bridge] Idle timeout (${IDLE_TIMEOUT_MS / 1000}s) for session ${sessionId}, force-sending`,
      );
      this.flushAndReply(sessionId);
    }, IDLE_TIMEOUT_MS);
  }

  /** Clear idle timer for a context */
  private clearIdleTimer(ctx: SessionContext): void {
    if (ctx.idleTimer) {
      clearTimeout(ctx.idleTimer);
      ctx.idleTimer = undefined;
    }
  }

  /** Flush accumulated text and send reply, then clean up */
  private flushAndReply(sessionId: string, notifyEmpty = true): void {
    const ctx = this.activeContexts.get(sessionId);
    if (!ctx) return;

    this.clearIdleTimer(ctx);
    ctx.onTyping?.(false);

    // The turn is ending (idle, error, or shutdown) — a question still hanging
    // here will never be answered, and leaving it unresolved keeps the agent
    // blocked inside tool execution.
    if (ctx.pendingQuestion) {
      this.resolvePendingQuestion(ctx, (pending) =>
        this.getClient(ctx.workspaceDir).rejectQuestion(pending.id),
      );
    }

    // Only what streaming has not already delivered (send() applies the cap)
    const full = Array.from(ctx.textParts.values()).join("\n\n");
    const text = ctx.chunker.rest(full);
    if (text) {
      this.send(ctx, text);
    } else if (notifyEmpty && !ctx.saidSomething) {
      // Before the reasoning/user-echo filters landed, textParts always held at
      // least the echoed prompt, so an empty flush was impossible. Now a turn
      // that only produced reasoning or tool calls really can end up with no
      // text — staying silent would read as the bot ignoring the user. (If blocks
      // already went out, an empty remainder just means the answer ended on a
      // block boundary — nothing to announce.)
      this.send(ctx, EMPTY_REPLY_NOTICE);
    }

    this.clearAck(ctx);

    this.activeContexts.delete(sessionId);
    console.log(
      `[Bridge] Session ${sessionId} idle, replied ${text.length} chars`,
    );

    // Update session title with sender info (fire-and-forget)
    this.updateSessionTitle(ctx).catch((err) => {
      console.error(`[Bridge] Title update failed for ${ctx.sessionId}:`, err);
    });
  }

  /** Prepend [渠道·senderName] to the auto-generated session title */
  private async updateSessionTitle(ctx: SessionContext): Promise<void> {
    const client = this.getClient(ctx.workspaceDir);
    const session = await client.getSession(ctx.sessionId);
    const label = CHANNEL_LABELS[ctx.channelType] || ctx.channelType;
    const prefix = `[${label}·${ctx.senderName}]`;

    // Don't add prefix if already present (session reuse from same chat)
    const hasChannelPrefix = /^\[.+·/.test(session.title || "");
    if (session.title && !hasChannelPrefix) {
      const newTitle = `${prefix} ${session.title}`;
      await client.updateSession(ctx.sessionId, { title: newTitle });
      console.log(`[Bridge] Updated title: "${newTitle}"`);
    }
  }

  /** Ensure SSE connection is active for a workspace. Returns when connected. */
  private async ensureSSE(workspaceDir: string): Promise<void> {
    const backend = this.getBackend(workspaceDir);
    if (!this.sseSubscriptions.has(workspaceDir)) {
      this.sseSubscriptions.set(
        workspaceDir,
        backend.subscribeGlobal((event) => this.handleSSEEvent(event)),
      );
      backend.connectGlobal();
    }
    // Resolves on first open OR first error — processMessage never hangs.
    return backend.ready();
  }

  private handleSSEEvent(event: { type: string; properties: any }): void {
    switch (event.type) {
      case "message.updated":
        this.onMessageUpdated(event.properties.info);
        break;
      case "message.part.updated":
        this.onPartUpdated(event.properties.part);
        break;
      case "message.part.delta":
        this.onPartDelta(event.properties);
        break;
      case "session.status":
        this.onSessionStatus(
          event.properties.sessionID,
          event.properties.status,
        );
        break;
      case "permission.asked":
        this.onPermissionAsked(event.properties);
        break;
      case "question.asked":
        this.onQuestionAsked(event.properties);
        break;
      case "session.error":
        this.onSessionError(
          event.properties.sessionID,
          event.properties.error,
        );
        break;
    }
  }

  /** Track which messages are the assistant's, so user/synthetic parts can be dropped */
  private onMessageUpdated(info: {
    id: string;
    sessionID: string;
    role: string;
  }): void {
    if (info?.role !== "assistant") return;
    const ctx = this.activeContexts.get(info.sessionID);
    if (!ctx) return;
    ctx.assistantMessageIds.add(info.id);
  }

  /** Accumulate assistant text from full part updates */
  private onPartUpdated(part: MessagePart): void {
    const ctx = this.activeContexts.get(part.sessionID);
    if (!ctx) return;

    // Any part activity means the agent is alive — reasoning and tool parts
    // included. This must happen before the content filters below: a long
    // thinking block or a slow tool produces no text parts for minutes, and
    // letting the idle fallback fire there would force-send a partial reply.
    // While a question is pending the fallback stays off: it is the user we are
    // waiting on, and re-arming here would force-send the reply out from under
    // the question they are still reading.
    if (!ctx.pendingQuestion) this.startIdleTimer(ctx.sessionId);

    if (!ctx.assistantMessageIds.has(part.messageID)) return;
    if (part.type !== "text") return;

    const text = (part as any).content ?? (part as any).text ?? "";
    ctx.textPartIds.add(part.id);
    ctx.textParts.set(part.id, text);

    this.streamReadyBlocks(ctx);
  }

  /** Accumulate assistant text from delta (incremental append) */
  private onPartDelta(props: {
    sessionID: string;
    partID: string;
    field: string;
    delta: string;
  }): void {
    const ctx = this.activeContexts.get(props.sessionID);
    if (!ctx) return;

    if (!ctx.pendingQuestion) this.startIdleTimer(ctx.sessionId);

    if (props.field !== "content" && props.field !== "text") return;
    // The delta event carries no type and reasoning-delta also arrives as
    // `field: "text"` — only a partID already seen as an assistant text part
    // may be appended to, or the model's chain of thought lands in the chat.
    if (!ctx.textPartIds.has(props.partID)) return;

    const existing = ctx.textParts.get(props.partID) ?? "";
    ctx.textParts.set(props.partID, existing + props.delta);

    this.streamReadyBlocks(ctx);
  }

  /** Session went idle → send accumulated reply */
  private onSessionStatus(
    sessionId: string,
    status: { type: string },
  ): void {
    if (status.type !== "idle") return;
    this.flushAndReply(sessionId);
  }

  /** Auto-reply permission with "once" */
  private onPermissionAsked(perm: { id: string; sessionID: string }): void {
    const ctx = this.activeContexts.get(perm.sessionID);
    if (!ctx) return;

    const client = this.getClient(ctx.workspaceDir);
    client.replyPermission(perm.id, "once").catch((err) => {
      console.error(
        `[Bridge] Auto-reply permission ${perm.id} failed:`,
        err,
      );
    });
    console.log(`[Bridge] Auto-approved permission ${perm.id}`);
  }

  /** Forward the agent's question to the chat and wait for the user's reply */
  private onQuestionAsked(question: {
    id: string;
    sessionID: string;
    questions?: QuestionInfo[];
  }): void {
    const ctx = this.activeContexts.get(question.sessionID);
    if (!ctx) return;
    // SSE and the poll can both deliver the same question — ask once.
    if (ctx.pendingQuestion?.id === question.id) return;
    if (ctx.resolvedQuestionIds.has(question.id)) return;

    const questions = question.questions ?? [];
    if (questions.length === 0) {
      // Nothing renderable — decline rather than strand the agent.
      ctx.resolvedQuestionIds.add(question.id);
      this.getClient(ctx.workspaceDir)
        .rejectQuestion(question.id)
        .catch(() => {});
      return;
    }

    // The turn is blocked from here on: no parts, no status changes. Stop the
    // idle fallback or it would force-send a partial reply out from under us
    // while the user is still reading the question.
    this.clearIdleTimer(ctx);
    ctx.onTyping?.(false);

    // Whatever the agent said leading up to the question ("I need to check one
    // thing first…") is still sitting in the buffer, below the block threshold.
    // Send it now: streaming is suspended while the question is up, so otherwise
    // it would surface after the question it was introducing.
    const preamble = ctx.chunker.rest(
      Array.from(ctx.textParts.values()).join("\n\n"),
    );
    if (preamble) this.sendRemainder(ctx, preamble);

    const timer = setTimeout(() => {
      console.log(
        `[Bridge] Question ${question.id} unanswered after ${QUESTION_TIMEOUT_MS / 60_000} min, rejecting`,
      );
      this.resolvePendingQuestion(ctx, (pending) =>
        this.getClient(ctx.workspaceDir).rejectQuestion(pending.id),
      );
      // reject() makes the question tool throw inside the turn — the agent keeps
      // running and may still answer, so don't claim the turn is over. Re-arm the
      // idle fallback, which was suspended while the question was up.
      this.send(ctx, "⌛ 提问已超时，已替你跳过这个问题。");
      this.startIdleTimer(ctx.sessionId);
    }, QUESTION_TIMEOUT_MS);

    ctx.pendingQuestion = { id: question.id, questions, timer };
    this.send(ctx, renderQuestions(questions));
    console.log(`[Bridge] Asked user question ${question.id}`);
  }

  /**
   * Route a chat message into the question the agent is blocked on.
   * Returns false when the message is not an answer and should be treated as a
   * fresh prompt.
   */
  private async answerPendingQuestion(
    ctx: SessionContext,
    msg: IncomingMessage,
  ): Promise<void> {
    const pending = ctx.pendingQuestion!;
    const client = this.getClient(ctx.workspaceDir);
    const text = msg.text.trim();

    if (text === QUESTION_SKIP_COMMAND) {
      this.resolvePendingQuestion(ctx, (p) => client.rejectQuestion(p.id));
      await msg.reply("已跳过该问题。").catch(() => {});
      return;
    }

    const parsed = parseAnswer(text, pending.questions);
    if (!parsed.ok) {
      // Keep waiting — a malformed answer must not fall through to promptAsync,
      // which opencode would reject with BusyError while the question blocks.
      //
      // This is the one place carrying agent-authored text that cannot go through
      // `send()`: the re-ask must reply to THIS message (an adapter's `reply` is
      // bound to the incoming message), while `send` uses the turn's original
      // one. So the degradation (ADR-070 D5) is applied here by hand — without
      // it the same question would show degraded when first asked and as raw
      // LaTeX when re-asked.
      await msg
        .reply(
          degradeMathToUnicode(
            `${parsed.error}\n\n${renderQuestions(pending.questions)}`,
          ),
        )
        .catch(() => {});
      return;
    }

    this.resolvePendingQuestion(ctx, (p) =>
      client.replyQuestion(p.id, parsed.answers),
    );
    // The turn resumes: parts start flowing again, so re-arm the idle fallback.
    this.startIdleTimer(ctx.sessionId);
    ctx.onTyping?.(true);
    console.log(`[Bridge] Answered question ${pending.id}`);
  }

  /**
   * Clear the pending-question state, then run the resolution call. The pending
   * record is passed in: the field is already cleared by the time `resolve` runs,
   * so it must not close over `ctx.pendingQuestion`.
   */
  private resolvePendingQuestion(
    ctx: SessionContext,
    resolve: (pending: PendingQuestion) => Promise<void>,
  ): void {
    const pending = ctx.pendingQuestion;
    if (!pending) return;
    clearTimeout(pending.timer);
    ctx.pendingQuestion = undefined;
    ctx.resolvedQuestionIds.add(pending.id);
    resolve(pending).catch((err) => {
      console.error(`[Bridge] Resolving question ${pending.id} failed:`, err);
    });
  }

  /** Handle session.error SSE event — notify user and clean up */
  private onSessionError(
    sessionId: string | undefined,
    error: unknown,
  ): void {
    if (!sessionId) return;
    const ctx = this.activeContexts.get(sessionId);
    if (!ctx) return;

    const errMsg =
      error && typeof error === "object" && "data" in error
        ? (error as { data?: { message?: string } }).data?.message
        : undefined;
    console.error(
      `[Bridge] session.error for ${sessionId}:`,
      errMsg ?? error,
    );

    this.clearIdleTimer(ctx);
    ctx.onTyping?.(false);
    if (ctx.pendingQuestion) {
      this.resolvePendingQuestion(ctx, (pending) =>
        this.getClient(ctx.workspaceDir).rejectQuestion(pending.id),
      );
    }

    // Flush whatever text has not gone out yet, then always say it failed. The
    // remainder is often empty (the blocks already streamed), and silence there
    // would leave the user with an answer that merely stops mid-way.
    const full = Array.from(ctx.textParts.values()).join("\n\n");
    const remainder = ctx.chunker.rest(full);
    if (remainder) this.sendRemainder(ctx, remainder);
    this.send(ctx, "⚠️ AI agent encountered an error. Please try again.");

    this.clearAck(ctx);
    this.activeContexts.delete(sessionId);
  }

  /** Start polling for permission/question as SSE backup */
  private ensurePolling(workspaceDir: string, sessionId: string): void {
    const key = `${workspaceDir}:${sessionId}`;
    if (this.pollTimers.has(key)) return;

    const client = this.getClient(workspaceDir);
    let deadline = Date.now() + POLL_MAX_LIFETIME_MS;
    const timer = setInterval(async () => {
      const ctx = this.activeContexts.get(sessionId);
      // Waiting on the user is not a stuck turn — the question's own 30-min
      // timeout bounds it. Without this the poll would die mid-question and
      // stop backing up SSE for whatever the agent asks next.
      if (ctx?.pendingQuestion) {
        deadline = Date.now() + POLL_MAX_LIFETIME_MS;
      }

      // Stop polling if no active context or max lifetime exceeded
      if (!ctx || Date.now() > deadline) {
        clearInterval(timer);
        this.pollTimers.delete(key);
        return;
      }

      try {
        const permissions = await client.listPermissions();
        for (const p of permissions) {
          if (p.sessionID === sessionId) {
            this.onPermissionAsked(p);
          }
        }
      } catch {
        // Ignore poll errors
      }

      try {
        const questions = await client.listQuestions();
        for (const q of questions) {
          if (q.sessionID === sessionId) {
            this.onQuestionAsked(q);
          }
        }
      } catch {
        // Ignore poll errors
      }
    }, POLL_INTERVAL_MS);

    this.pollTimers.set(key, timer);
  }

  async shutdown(): Promise<void> {
    // Flush any pending replies before shutting down. No empty-turn notice here —
    // the gateway is going down, and "no text this turn" is not news worth sending.
    for (const sessionId of [...this.activeContexts.keys()]) {
      this.flushAndReply(sessionId, false);
    }

    // Close all SSE connections and backend resources
    for (const unsubscribe of this.sseSubscriptions.values()) {
      unsubscribe();
    }
    this.sseSubscriptions.clear();
    for (const backend of this.backends.values()) {
      backend.dispose();
    }

    // Clear all poll timers
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    // Persist session map before clearing
    await this.store.save().catch(() => {});

    this.activeContexts.clear();
    this.store = new SessionStore();
    this.backends.clear();
    this.queues.clear();
  }
}
