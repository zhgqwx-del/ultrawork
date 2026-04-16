import { createApiClient } from "@agent/api-client";
import type { ApiClient, MessagePart } from "@agent/api-client";
import type { IncomingMessage } from "./types.js";
import { loadSessionMap, saveSessionMap } from "./session-store.js";

const OPENCODE_BASE_URL = "http://localhost:4096";
const OPENCODE_PASSWORD = "test123";
const MAX_REPLY_LENGTH = 20_000; // Safe limit for messaging platforms (DingTalk, WeChat, etc.)
const POLL_INTERVAL_MS = 3_000; // Permission/question poll interval
const IDLE_TIMEOUT_MS = 180_000; // 3 min — force-send if idle event missed
const POLL_MAX_LIFETIME_MS = 300_000; // 5 min — auto-stop polling even if session stuck

/** Channel type → display label mapping */
const CHANNEL_LABELS: Record<string, string> = {
  dingtalk: "钉钉",
  wechat: "微信",
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
  /** Per-workspace ApiClient cache */
  private clients = new Map<string, ApiClient>();
  /** SSE abort controllers per workspace */
  private sseControllers = new Map<string, AbortController>();
  /** SSE "connected" promise per workspace — resolves when first SSE read succeeds */
  private sseReady = new Map<string, Promise<void>>();
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

  /** Get or create an ApiClient for a workspace directory */
  private getClient(workspaceDir: string): ApiClient {
    let client = this.clients.get(workspaceDir);
    if (!client) {
      client = createApiClient({
        baseUrl: OPENCODE_BASE_URL,
        username: "opencode",
        password: OPENCODE_PASSWORD,
        workingDirectory: workspaceDir,
      });
      this.clients.set(workspaceDir, client);
    }
    return client;
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
      await client.promptAsync(sessionId, msg.text, { model });
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
    const existing = this.sseReady.get(workspaceDir);
    if (existing) return existing;

    const controller = new AbortController();
    this.sseControllers.set(workspaceDir, controller);

    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.sseReady.set(workspaceDir, readyPromise);

    this.connectSSE(workspaceDir, controller.signal, () =>
      resolveReady(),
    ).catch((err) => {
      console.error(`[Bridge] SSE connection error for ${workspaceDir}:`, err);
      this.sseControllers.delete(workspaceDir);
      this.sseReady.delete(workspaceDir);
      // Resolve anyway so processMessage doesn't hang forever
      resolveReady();
    });

    return readyPromise;
  }

  private async connectSSE(
    workspaceDir: string,
    signal: AbortSignal,
    onConnected: () => void,
  ): Promise<void> {
    const params = new URLSearchParams({ directory: workspaceDir });
    const url = `${OPENCODE_BASE_URL}/event?${params}`;
    const credentials = btoa(`opencode:${OPENCODE_PASSWORD}`);
    let backoff = 1000; // Start at 1s, max 30s
    let firstConnect = true;

    while (!signal.aborted) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Basic ${credentials}`,
            "x-opencode-directory": encodeURIComponent(workspaceDir),
          },
          signal,
        });

        if (!response.ok) {
          throw new Error(`SSE ${response.status} ${response.statusText}`);
        }
        if (!response.body) throw new Error("SSE response has no body");

        console.log(`[Bridge] SSE connected for ${workspaceDir}`);
        backoff = 1000; // Reset on successful connect

        // Signal that SSE is ready (only matters on first connect)
        if (firstConnect) {
          firstConnect = false;
          onConnected();
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6));
                this.handleSSEEvent(event);
              } catch {
                console.warn(`[Bridge] Unparseable SSE event: ${line.slice(0, 100)}`);
              }
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        console.error(`[Bridge] SSE error, reconnecting in ${backoff / 1000}s:`, err);
        // Signal ready even on error so processMessage doesn't hang
        if (firstConnect) {
          firstConnect = false;
          onConnected();
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000); // Exponential backoff, cap 30s
      }
    }
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

    // Abort all SSE connections
    for (const controller of this.sseControllers.values()) {
      controller.abort();
    }
    this.sseControllers.clear();
    this.sseReady.clear();

    // Clear all poll timers
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    // Persist session map before clearing
    await saveSessionMap(this.sessionMap).catch(() => {});

    this.activeContexts.clear();
    this.sessionMap.clear();
    this.clients.clear();
    this.queues.clear();
  }
}
