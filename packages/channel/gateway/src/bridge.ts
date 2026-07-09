import { OpenCodeBackend, UNLIMITED_SSE_RETRY, type Unsubscribe } from "@agent/connector";
import type { ApiClient, MessagePart } from "@agent/api-client";
import type { IncomingMessage } from "./types.js";
import { loadSessionMap, saveSessionMap } from "./session-store.js";

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
const POLL_INTERVAL_MS = 3_000; // Permission/question poll interval
const IDLE_TIMEOUT_MS = 180_000; // 3 min — force-send if idle event missed
const POLL_MAX_LIFETIME_MS = 300_000; // 5 min — auto-stop polling even if session stuck

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
  senderName: string;
  channelType: string;
  /** Accumulated text per partID (handles multiple text parts) */
  textParts: Map<string, string>;
  /** Callback to reply to the originating message */
  reply: (content: string) => Promise<void>;
  /** Optional: typing indicator callback */
  onTyping?: (typing: boolean) => void;
  /** Idle timeout handle — force-sends accumulated text if SSE misses idle event */
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Bridge between channel adapters and OpenCode Server.
 * - Maps chatId → OpenCode session
 * - Sequential queue per chat to prevent concurrent prompts
 * - SSE subscription to collect assistant output and reply on idle
 * - Auto-handles permission (once) and question (reject)
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
          this.activeContexts.delete(oldSessionId);
        }
      }
      this.sessionMap.delete(msg.chatId);
      this.persistSessionMap();
      await msg.reply("✅ 已重置对话，下条消息将开启新会话").catch(() => {});
      return;
    }

    // Instantly acknowledge receipt to the user (before any network calls)
    msg.reply("⏳ 收到，正在处理").catch((err) => {
      console.error(`[Bridge] Instant ack failed for ${msg.chatId}:`, err);
    });

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
      senderName: msg.senderName,
      channelType: msg.channelType,
      textParts: new Map(),
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
      ctx.onTyping?.(false);
      this.activeContexts.delete(sessionId);
      await msg
        .reply(`Error: Failed to send message to AI agent.`)
        .catch(() => {});
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
  private flushAndReply(sessionId: string): void {
    const ctx = this.activeContexts.get(sessionId);
    if (!ctx) return;

    this.clearIdleTimer(ctx);
    ctx.onTyping?.(false);

    const text = Array.from(ctx.textParts.values()).join("\n\n").trim();
    if (text) {
      const truncated =
        text.length > MAX_REPLY_LENGTH
          ? text.slice(0, MAX_REPLY_LENGTH) + "\n\n...(truncated)"
          : text;

      ctx.reply(truncated).catch((err) => {
        console.error(`[Bridge] Reply failed for ${ctx.chatId}:`, err);
      });
    }

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

  /** Accumulate assistant text from full part updates */
  private onPartUpdated(part: MessagePart): void {
    if (part.type !== "text") return;
    const ctx = this.activeContexts.get(part.sessionID);
    if (!ctx) return;
    const partId = (part as any).id ?? "__default__";
    const text = (part as any).content ?? (part as any).text ?? "";
    ctx.textParts.set(partId, text);

    // Reset idle timer — agent is still producing output
    this.startIdleTimer(ctx.sessionId);
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
    if (props.field === "content" || props.field === "text") {
      const existing = ctx.textParts.get(props.partID) ?? "";
      ctx.textParts.set(props.partID, existing + props.delta);

      // Reset idle timer — agent is still producing output
      this.startIdleTimer(ctx.sessionId);
    }
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

  /** Auto-reject question */
  private onQuestionAsked(question: { id: string; sessionID: string }): void {
    const ctx = this.activeContexts.get(question.sessionID);
    if (!ctx) return;

    const client = this.getClient(ctx.workspaceDir);
    client.rejectQuestion(question.id).catch((err) => {
      console.error(
        `[Bridge] Auto-reject question ${question.id} failed:`,
        err,
      );
    });
    console.log(`[Bridge] Auto-rejected question ${question.id}`);
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

    // Only reply if no text has been accumulated (avoid overwriting a partial response)
    const accumulated = Array.from(ctx.textParts.values()).join("").trim();
    if (!accumulated) {
      ctx
        .reply("⚠️ AI agent encountered an error. Please try again.")
        .catch(() => {});
    } else {
      // Flush whatever we have
      this.flushAndReply(sessionId);
      return;
    }

    this.activeContexts.delete(sessionId);
  }

  /** Start polling for permission/question as SSE backup */
  private ensurePolling(workspaceDir: string, sessionId: string): void {
    const key = `${workspaceDir}:${sessionId}`;
    if (this.pollTimers.has(key)) return;

    const client = this.getClient(workspaceDir);
    const startTime = Date.now();
    const timer = setInterval(async () => {
      // Stop polling if no active context or max lifetime exceeded
      if (!this.activeContexts.has(sessionId) || Date.now() - startTime > POLL_MAX_LIFETIME_MS) {
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
    // Flush any pending replies before shutting down
    for (const sessionId of [...this.activeContexts.keys()]) {
      this.flushAndReply(sessionId);
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
