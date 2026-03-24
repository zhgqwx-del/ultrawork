import type {
  ChannelAdapter,
  ChannelState,
  ChannelStatus,
  IncomingMessage,
  WeChatChannelConfig,
} from "../../types.js";
import type { WeixinMessage } from "./types.js";
import { ITEM_TYPE_TEXT, ITEM_TYPE_VOICE, MSG_TYPE_USER } from "./types.js";
import { ILinkApi } from "./ilink-api.js";

const CONSECUTIVE_FAIL_THRESHOLD = 3;
const FAIL_BACKOFF_MS = 30_000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_EXPIRED_PAUSE_MS = 60_000;

export class WeChatAdapter implements ChannelAdapter {
  readonly type = "wechat";
  readonly id: string;
  readonly name: string;

  private state: ChannelState = "disconnected";
  private errorMsg?: string;
  private connectedAt?: string;
  private workspaceDir: string;
  private api: ILinkApi;
  private ilinkBotId: string;
  private messageHandler: (msg: IncomingMessage) => void;

  /** Long-poll cursor (persisted across reconnects within this session) */
  private updatesCursor: string = "";
  /** Abort controller for the long-poll loop */
  private pollAbort?: AbortController;
  /** Context tokens per user (from_user_id → last context_token) */
  private contextTokens = new Map<string, string>();
  /** Typing ticket (fetched lazily from getconfig) */
  private typingTicket: string = "";
  private typingTicketFetching = false;

  constructor(
    config: WeChatChannelConfig,
    onMessage: (msg: IncomingMessage) => void,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.workspaceDir = config.workspaceDir;
    this.messageHandler = onMessage;
    this.ilinkBotId = config.ilinkBotId;
    this.api = new ILinkApi(config.botToken, config.baseUrl);
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";
    this.errorMsg = undefined;

    // Start long-poll loop — first successful getupdates confirms connection
    this.startPolling();
    this.connectedAt = new Date().toISOString();
    console.log(`[WeChat] "${this.name}" connecting, starting poll loop`);
  }

  async disconnect(): Promise<void> {
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    this.state = "disconnected";
    this.connectedAt = undefined;
    console.log(`[WeChat] "${this.name}" disconnected`);
  }

  getStatus(): ChannelStatus {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      state: this.state,
      error: this.errorMsg,
      connectedAt: this.connectedAt,
    };
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    // Strip markdown for WeChat plain text display
    const plainText = stripMarkdown(content);
    const contextToken = this.contextTokens.get(chatId) || "";
    const resp = await this.api.sendTextMessage(
      chatId,
      this.ilinkBotId,
      plainText,
      contextToken,
    );
    if (resp.ret !== 0) {
      throw new Error(
        `WeChat sendMessage failed: ret=${resp.ret} ${resp.errmsg || ""}`,
      );
    }
  }

  // ---- Long-poll loop ----

  private startPolling(): void {
    this.pollAbort?.abort();
    const controller = new AbortController();
    this.pollAbort = controller;

    this.pollLoop(controller.signal).catch((err) => {
      if (err instanceof Error && err.name === "AbortError") return;
      console.error(`[WeChat] Poll loop crashed for "${this.name}":`, err);
      this.state = "error";
      this.errorMsg = err instanceof Error ? err.message : "Poll loop crashed";
    });
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        const resp = await this.api.getUpdates(this.updatesCursor);

        // Check for session expiry
        if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
          console.warn(
            `[WeChat] Session expired for "${this.name}", pausing ${SESSION_EXPIRED_PAUSE_MS / 1000}s`,
          );
          this.state = "error";
          this.errorMsg = "Session expired, please re-login";
          await sleep(SESSION_EXPIRED_PAUSE_MS, signal);
          continue;
        }

        // ret=0 means success; undefined/missing ret is treated as empty poll (no messages)
        if (resp.ret !== undefined && resp.ret !== 0) {
          throw new Error(`getupdates ret=${resp.ret}: ${resp.errmsg || ""}`);
        }

        // Update cursor for next poll
        if (resp.get_updates_buf) {
          this.updatesCursor = resp.get_updates_buf;
        }

        // Process messages
        for (const msg of resp.msgs ?? []) {
          if (msg.message_type === MSG_TYPE_USER) {
            this.handleIncomingMessage(msg);
          }
        }

        consecutiveFailures = 0;
        // Ensure connected state after successful poll
        if (this.state !== "connected") {
          this.state = "connected";
          this.errorMsg = undefined;
          // Lazily fetch typing ticket after first successful connection
          this.fetchTypingTicket();
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;

        consecutiveFailures++;
        console.error(
          `[WeChat] getupdates failed (${consecutiveFailures}):`,
          err,
        );

        if (consecutiveFailures >= CONSECUTIVE_FAIL_THRESHOLD) {
          console.warn(
            `[WeChat] ${consecutiveFailures} consecutive failures, backing off ${FAIL_BACKOFF_MS / 1000}s`,
          );
          await sleep(FAIL_BACKOFF_MS, signal);
        }
      }
    }
  }

  private handleIncomingMessage(msg: WeixinMessage): void {
    try {
      // Store context token for reply
      if (msg.context_token) {
        this.contextTokens.set(msg.from_user_id, msg.context_token);
      }

      // Lazily fetch typing ticket on first message (needs a user ID)
      if (!this.typingTicket) {
        this.fetchTypingTicket(msg.from_user_id);
      }

      // Extract text from items
      const textParts: string[] = [];
      for (const item of msg.item_list ?? []) {
        if (item.type === ITEM_TYPE_TEXT && item.text_item?.text) {
          textParts.push(item.text_item.text);
        } else if (
          item.type === ITEM_TYPE_VOICE &&
          item.voice_item?.text
        ) {
          // Use STT transcription as text input
          textParts.push(item.voice_item.text);
        }
      }

      const text = textParts.join("\n").trim();
      if (!text) {
        console.log(
          `[WeChat] Skipping non-text message from ${msg.from_user_id}`,
        );
        return;
      }

      const chatId = msg.from_user_id;
      const contextToken = msg.context_token || "";

      const incomingMessage: IncomingMessage = {
        chatId,
        senderId: msg.from_user_id,
        senderName: msg.from_user_id.slice(-6), // Last 6 chars as display name
        channelType: "wechat",
        text,
        workspaceDir: this.workspaceDir,
        raw: msg,
        reply: async (content: string) => {
          const plain = stripMarkdown(content);
          await this.api.sendTextMessage(
            chatId,
            this.ilinkBotId,
            plain,
            contextToken,
          );
        },
        onTyping: (typing: boolean) => {
          this.sendTyping(msg.from_user_id, typing);
        },
      };

      console.log(
        `[WeChat] Message from ${chatId}: "${text.slice(0, 50)}..."`,
      );

      this.messageHandler(incomingMessage);
    } catch (err) {
      console.error("[WeChat] Failed to handle message:", err);
    }
  }

  /** Fetch typing ticket from getconfig (fire-and-forget, retries on first message) */
  private fetchTypingTicket(userId?: string): void {
    if (this.typingTicket || this.typingTicketFetching) return;
    const uid = userId || this.contextTokens.keys().next().value;
    if (!uid) return;

    this.typingTicketFetching = true;
    this.api.getConfig(uid).then((resp) => {
      if (resp.ret === 0 && resp.typing_ticket) {
        this.typingTicket = resp.typing_ticket;
        console.log(`[WeChat] Got typing ticket`);
      }
    }).catch(() => {
      // Non-critical — typing indicator just won't work
    }).finally(() => {
      this.typingTicketFetching = false;
    });
  }

  /** Send typing indicator to a user (best-effort) */
  sendTyping(userId: string, typing: boolean): void {
    if (!this.typingTicket) return;
    this.api.sendTyping(userId, this.typingTicket, typing ? 1 : 2);
  }
}

/** Factory function for ChannelManager registration */
export function createWeChatAdapter(
  config: import("../../types.js").ChannelConfig,
  onMessage: (msg: IncomingMessage) => void,
): ChannelAdapter {
  return new WeChatAdapter(
    config as WeChatChannelConfig,
    onMessage,
  );
}

// ---- Helpers ----

/** Strip markdown formatting for plain text WeChat display */
function stripMarkdown(md: string): string {
  return md
    // Code blocks → content only
    .replace(/```[\s\S]*?```/g, (match) => {
      const lines = match.split("\n");
      return lines.slice(1, -1).join("\n");
    })
    // Inline code
    .replace(/`([^`]+)`/g, "$1")
    // Bold/italic
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // Images → remove (must be BEFORE links, since link regex matches inside image syntax)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    // Links → display text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Headers → text only
    .replace(/^#{1,6}\s+/gm, "")
    // Blockquotes
    .replace(/^>\s+/gm, "")
    // HR
    .replace(/^-{3,}$/gm, "")
    // Clean up extra blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}
