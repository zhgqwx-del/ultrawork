import { OpenCodeBackend, UNLIMITED_SSE_RETRY, type Unsubscribe } from "@agent/connector";
import type { ApiClient, MessagePart, QuestionInfo } from "@agent/api-client";
import type { IncomingMessage } from "./types.js";
import { loadSessionMap, saveSessionMap } from "./session-store.js";
import {
  parseAnswer,
  renderQuestions,
  QUESTION_SKIP_COMMAND,
} from "./question-prompt.js";
import { BlockChunker } from "./block-chunker.js";

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
  /** Splits the reply into blocks that can be sent as the turn progresses */
  chunker: BlockChunker;
  /** Pending "still working" ack — cancelled if output arrives first */
  ackTimer?: ReturnType<typeof setTimeout>;
  /** Whether anything at all has been sent to the user this turn */
  saidSomething: boolean;
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
  /** chatId → OpenCode sessionId */
  private sessionMap = new Map<string, string>();
  /** sessionId → active context for current turn */
  private activeContexts = new Map<string, SessionContext>();
  /** chatId → sequential promise chain */
  private queues = new Map<string, Promise<void>>();
  /** Per-workspace OpenCode backend (ApiClient + global SSE, via @agent/connector) */
  private backends = new Map<string, OpenCodeBackend>();
  /** Global-stream subscriptions per workspace */
  private sseSubscriptions = new Map<string, Unsubscribe>();
  /** Permission/question poll timers per workspace */
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();

  /** Restore persisted session mappings from disk */
  async init(): Promise<void> {
    this.sessionMap = await loadSessionMap();
    if (this.sessionMap.size > 0) {
      console.log(`[Bridge] Restored ${this.sessionMap.size} session mappings`);
    }
  }

  /** Persist session map to disk (fire-and-forget) */
  private persistSessionMap(): void {
    saveSessionMap(this.sessionMap).catch((err) => {
      console.error("[Bridge] Failed to persist session map:", err);
    });
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
    await this.enqueue(msg.chatId, () => this.processMessage(msg));
  }

  private async processMessage(msg: IncomingMessage): Promise<void> {
    // Handle /new command — reset session for this chat
    if (msg.text.trim() === "/new") {
      const oldSessionId = this.sessionMap.get(msg.chatId);
      if (oldSessionId) {
        // Clean up any active context for the old session
        const oldCtx = this.activeContexts.get(oldSessionId);
        if (oldCtx) {
          this.clearIdleTimer(oldCtx);
          this.clearAck(oldCtx);
          if (oldCtx.pendingQuestion) {
            // Don't leave the agent blocked on a question nobody will answer
            this.resolvePendingQuestion(oldCtx, (pending) =>
              this.getClient(oldCtx.workspaceDir).rejectQuestion(pending.id),
            );
          }
          this.activeContexts.delete(oldSessionId);
        }
      }
      this.sessionMap.delete(msg.chatId);
      this.persistSessionMap();
      await msg.reply("✅ 已重置对话，下条消息将开启新会话").catch(() => {});
      return;
    }

    // If the agent is blocked on a question, this message is the answer — not a
    // new prompt. opencode keeps the session busy while a question is pending,
    // so sending it as a prompt would just come back as BusyError.
    const activeSessionId = this.sessionMap.get(msg.chatId);
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
        return;
      }
      await this.answerPendingQuestion(activeCtx, msg);
      return;
    }

    // Hold the ack briefly. Blocks now stream out as the agent produces them, so
    // if the first one lands quickly the ack is cancelled unsent and the user
    // sees real content instead of a placeholder followed by the same answer.
    const ackTimer = setTimeout(() => {
      msg.reply(ACK_TEXT).catch((err) => {
        console.error(`[Bridge] Ack failed for ${msg.chatId}:`, err);
      });
    }, ACK_DELAY_MS);

    const client = this.getClient(msg.workspaceDir);

    // Get or create session for this chat
    let sessionId = this.sessionMap.get(msg.chatId);
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
      this.sessionMap.set(msg.chatId, sessionId);
      this.persistSessionMap();
      console.log(
        `[Bridge] Created session ${sessionId} for chat ${msg.chatId}`,
      );
    }

    // Set up context to accumulate reply
    const ctx: SessionContext = {
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
      saidSomething: false,
      ackTimer,
      reply: msg.reply,
      onTyping: msg.onTyping,
    };
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
      this.clearIdleTimer(ctx);
      this.clearAck(ctx);
      ctx.onTyping?.(false);
      this.activeContexts.delete(sessionId);
      await msg
        .reply(`Error: Failed to send message to AI agent.`)
        .catch(() => {});
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
    // Every outbound message passes through here, so the platform cap is enforced
    // in one place. Streamed blocks need it as much as the final flush does: a
    // single 25k-char paragraph is a valid block, and the channels reject or
    // silently truncate anything over their limit.
    const safe =
      text.length > MAX_REPLY_LENGTH
        ? text.slice(0, MAX_REPLY_LENGTH) + "\n\n...(truncated)"
        : text;
    ctx.reply(safe).catch((err) => {
      console.error(`[Bridge] Reply failed for ${ctx.chatId}:`, err);
    });
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
    this.startIdleTimer(ctx.sessionId);

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

    this.startIdleTimer(ctx.sessionId);

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

    const questions = question.questions ?? [];
    if (questions.length === 0) {
      // Nothing renderable — decline rather than strand the agent.
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

    const timer = setTimeout(() => {
      console.log(
        `[Bridge] Question ${question.id} unanswered after ${QUESTION_TIMEOUT_MS / 60_000} min, rejecting`,
      );
      this.resolvePendingQuestion(ctx, (pending) =>
        this.getClient(ctx.workspaceDir).rejectQuestion(pending.id),
      );
      ctx
        .reply("⌛ 提问已超时，本轮已结束。可以重新发消息继续。")
        .catch(() => {});
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
      await msg
        .reply(`${parsed.error}\n\n${renderQuestions(pending.questions)}`)
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

    // Only reply if no text has been accumulated (avoid overwriting a partial response)
    const accumulated = Array.from(ctx.textParts.values()).join("").trim();
    if (!accumulated) {
      this.send(ctx, "⚠️ AI agent encountered an error. Please try again.");
    } else {
      // Flush whatever we have
      this.flushAndReply(sessionId);
      return;
    }

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
    await saveSessionMap(this.sessionMap).catch(() => {});

    this.activeContexts.clear();
    this.sessionMap.clear();
    this.backends.clear();
    this.queues.clear();
  }
}
