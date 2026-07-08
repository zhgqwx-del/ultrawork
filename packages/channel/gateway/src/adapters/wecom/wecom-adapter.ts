/**
 * WeCom (企业微信) intelligent-robot adapter — long-connection mode via the
 * official `@wecom/aibot-node-sdk` (WebSocket to wss://openws.work.weixin.qq.com,
 * no public callback URL needed). Docs: developer.work.weixin.qq.com/document/path/101463.
 *
 * Platform constraints (028 §1.3): one active connection per botId (a newer
 * connection displaces this one via `event.disconnected_event`); per-chat rate
 * limits 30 msg/min & 1000 msg/h; active sends live inside a 24h reply window.
 */
import { WSClient } from "@wecom/aibot-node-sdk";
import type {
  ChannelAdapter,
  WeComChannelConfig,
  ChannelState,
  ChannelStatus,
  IncomingMessage,
} from "../../types.js";

const AUTH_TIMEOUT_MS = 15_000;

/** Minimal frame/message shapes we consume (mirrors SDK typings). */
interface WeComTextFrame {
  headers: { req_id: string };
  body?: {
    msgid: string;
    aibotid: string;
    chatid?: string;
    chattype: "single" | "group";
    from: { userid: string };
    text?: { content: string };
  };
}

export class WeComAdapter implements ChannelAdapter {
  readonly type = "wecom";
  readonly id: string;
  readonly name: string;

  private state: ChannelState = "disconnected";
  private errorMsg?: string;
  private connectedAt?: string;
  private workspaceDir: string;
  private wsClient: WSClient;
  private messageHandler: (msg: IncomingMessage) => void;

  constructor(
    config: WeComChannelConfig,
    onMessage: (msg: IncomingMessage) => void,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.workspaceDir = config.workspaceDir;
    this.messageHandler = onMessage;

    this.wsClient = new WSClient({
      botId: config.botId,
      secret: config.secret,
    });

    this.wsClient.on("message.text", (frame) => {
      this.handleTextMessage(frame as WeComTextFrame);
    });

    // A newer connection for the same botId displaces this one — the server
    // will not let us reconnect, so surface a terminal error state instead of
    // fighting over the slot.
    this.wsClient.on("event.disconnected_event", () => {
      this.state = "error";
      this.errorMsg = `WeCom bot taken over by another connection (one active connection per botId)`;
      console.error(`[WeCom] "${this.name}" displaced by another connection`);
      try {
        this.wsClient.disconnect();
      } catch {
        // ignore
      }
    });

    this.wsClient.on("disconnected", () => {
      // SDK auto-reconnects; only note it if we thought we were connected
      if (this.state === "connected") {
        console.warn(`[WeCom] "${this.name}" connection dropped, SDK reconnecting…`);
      }
    });

    this.wsClient.on("error", (err) => {
      console.error(`[WeCom] "${this.name}" ws error:`, err instanceof Error ? err.message : err);
    });
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";
    this.errorMsg = undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("WeCom authentication timed out"));
        }, AUTH_TIMEOUT_MS);
        const onAuth = () => {
          cleanup();
          resolve();
        };
        const onError = (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Only credential failures are terminal here; transient socket
          // errors are retried by the SDK until auth succeeds or times out.
          if (msg.includes("Authentication failed") || msg.includes("AUTH_FAILURE")) {
            cleanup();
            reject(err instanceof Error ? err : new Error(msg));
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.wsClient.off("authenticated", onAuth);
          this.wsClient.off("error", onError);
        };
        this.wsClient.on("authenticated", onAuth);
        this.wsClient.on("error", onError);
        this.wsClient.connect();
      });

      this.state = "connected";
      this.connectedAt = new Date().toISOString();
      console.log(`[WeCom] "${this.name}" connected`);
    } catch (err) {
      this.state = "error";
      this.errorMsg = err instanceof Error ? err.message : "Connection failed";
      try {
        this.wsClient.disconnect();
      } catch {
        // ignore
      }
      console.error(`[WeCom] "${this.name}" connect failed:`, err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.wsClient.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.state = "disconnected";
    this.connectedAt = undefined;
    console.log(`[WeCom] "${this.name}" disconnected`);
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
    // Active send within the 24h reply window. chatid: single chat → the
    // user's userid, group chat → the group chatid (we prefix group ids).
    const target = chatId.startsWith("group:") ? chatId.slice(6) : chatId;
    await this.wsClient.sendMessage(target, {
      msgtype: "markdown",
      markdown: { content },
    });
  }

  private handleTextMessage(frame: WeComTextFrame): void {
    try {
      const body = frame.body;
      const text = body?.text?.content?.trim();
      if (!body || !text) return;

      const chatId =
        body.chattype === "group" && body.chatid
          ? `group:${body.chatid}`
          : body.from.userid;

      const incomingMessage: IncomingMessage = {
        chatId,
        senderId: body.from.userid,
        // The long-connection payload carries no display name — userid is the
        // best stable label available without extra contact-book permissions.
        senderName: body.from.userid,
        channelType: "wecom",
        text,
        workspaceDir: this.workspaceDir,
        raw: body,
        reply: async (content: string) => {
          await this.sendMessage(chatId, content);
        },
      };

      console.log(
        `[WeCom] Message from ${body.from.userid} (${chatId}): "${text.slice(0, 50)}..."`,
      );

      this.messageHandler(incomingMessage);
    } catch (err) {
      console.error("[WeCom] Failed to handle message:", err);
    }
  }
}

/** Factory function for ChannelManager registration */
export function createWeComAdapter(
  config: import("../../types.js").ChannelConfig,
  onMessage: (msg: IncomingMessage) => void,
): ChannelAdapter {
  return new WeComAdapter(config as WeComChannelConfig, onMessage);
}
