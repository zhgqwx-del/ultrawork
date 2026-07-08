/**
 * Feishu (飞书/Lark) channel adapter — event long-connection via the official
 * `@larksuiteoapi/node-sdk` WSClient (no public callback URL needed), sending
 * through `im.v1.message.create`. Mirrors the larksuite/openclaw-lark plugin's
 * production wiring: EventDispatcher registered for `im.message.receive_v1`,
 * WSClient.start({eventDispatcher}).
 *
 * Feishu vs Lark tenants use different API domains — `config.domain` decides
 * (delivered by the registration flow's tenant_brand, 028 §1.3).
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  ChannelAdapter,
  FeishuChannelConfig,
  ChannelState,
  ChannelStatus,
  IncomingMessage,
} from "../../types.js";

type ReceiveEvent = {
  sender: { sender_id?: { open_id?: string }; sender_type: string };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string; // "p2p" | "group"
    message_type: string;
    content: string; // JSON string, e.g. {"text":"hi"}
    mentions?: Array<{ key: string; name: string }>;
  };
};

export class FeishuAdapter implements ChannelAdapter {
  readonly type = "feishu";
  readonly id: string;
  readonly name: string;

  private state: ChannelState = "disconnected";
  private errorMsg?: string;
  private connectedAt?: string;
  private workspaceDir: string;
  private config: FeishuChannelConfig;
  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private messageHandler: (msg: IncomingMessage) => void;

  constructor(
    config: FeishuChannelConfig,
    onMessage: (msg: IncomingMessage) => void,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.workspaceDir = config.workspaceDir;
    this.config = config;
    this.messageHandler = onMessage;

    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: this.domain(),
    });
  }

  private domain(): Lark.Domain {
    return this.config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";
    this.errorMsg = undefined;

    try {
      // SDK start() silently no-ops on malformed appIds (logs and returns) —
      // fail fast with an actionable message instead of a generic timeout.
      if (!/^cli_[0-9a-fA-F]+$/.test(this.config.appId)) {
        throw new Error(`Invalid Feishu App ID "${this.config.appId}" (expected cli_…)`);
      }

      const dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": (data) => {
          this.handleReceive(data as ReceiveEvent);
        },
      });

      // Close any prior socket before opening a new one (repeated connects
      // would otherwise leak orphan connections — openclaw-lark does the same).
      this.closeWs();

      // start() fires reConnect without awaiting it — connection state only
      // surfaces via the constructor's onReady/onError callbacks, so wrap
      // those into the connect() promise (with a timeout backstop).
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("Feishu connection timed out"));
          }
        }, 20_000);
        this.wsClient = new Lark.WSClient({
          appId: this.config.appId,
          appSecret: this.config.appSecret,
          domain: this.domain(),
          loggerLevel: Lark.LoggerLevel.warn,
          onReady: () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          },
          onError: (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error(msg));
            } else {
              // Post-connect terminal failure (e.g. reconnect exhausted)
              this.state = "error";
              this.errorMsg = msg;
              console.error(`[Feishu] "${this.name}" connection lost:`, msg);
            }
          },
        } as ConstructorParameters<typeof Lark.WSClient>[0]);
        void this.wsClient.start({ eventDispatcher: dispatcher });
      });

      this.state = "connected";
      this.connectedAt = new Date().toISOString();
      console.log(`[Feishu] "${this.name}" connected`);
    } catch (err) {
      this.state = "error";
      this.errorMsg = err instanceof Error ? err.message : "Connection failed";
      this.closeWs();
      console.error(`[Feishu] "${this.name}" connect failed:`, err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.closeWs();
    this.state = "disconnected";
    this.connectedAt = undefined;
    console.log(`[Feishu] "${this.name}" disconnected`);
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
    // p2p replies address the user's open_id; group replies the chat_id.
    const isGroup = chatId.startsWith("group:");
    const receiveId = isGroup ? chatId.slice(6) : chatId;
    await this.client.im.v1.message.create({
      params: { receive_id_type: isGroup ? "chat_id" : "open_id" },
      data: {
        receive_id: receiveId,
        msg_type: "text",
        content: JSON.stringify({ text: content }),
      },
    });
  }

  private closeWs(): void {
    if (this.wsClient) {
      try {
        // close() typing varies across SDK versions; force-close if available.
        (this.wsClient as unknown as { close?: (opts?: { force?: boolean }) => void }).close?.({ force: true });
      } catch {
        // ignore
      }
      this.wsClient = null;
    }
  }

  private handleReceive(data: ReceiveEvent): void {
    try {
      const message = data.message;
      if (!message || message.message_type !== "text") return;

      let text = "";
      try {
        text = (JSON.parse(message.content) as { text?: string }).text?.trim() ?? "";
      } catch {
        return;
      }
      // Strip @-mention placeholders (@_user_1 …) the group payload embeds
      for (const mention of message.mentions ?? []) {
        text = text.split(`@${mention.key}`).join("").trim();
      }
      if (!text) return;

      const senderOpenId = data.sender.sender_id?.open_id ?? "";
      const chatId = message.chat_type === "group" ? `group:${message.chat_id}` : senderOpenId;
      if (!chatId) return;

      const incomingMessage: IncomingMessage = {
        chatId,
        senderId: senderOpenId,
        // Long-connection payload has no display name (needs extra contact
        // scope) — mention name of self isn't the sender; use open_id.
        senderName: senderOpenId,
        channelType: "feishu",
        text,
        workspaceDir: this.workspaceDir,
        raw: data,
        reply: async (content: string) => {
          await this.sendMessage(chatId, content);
        },
      };

      console.log(
        `[Feishu] Message from ${senderOpenId} (${chatId}): "${text.slice(0, 50)}..."`,
      );

      this.messageHandler(incomingMessage);
    } catch (err) {
      console.error("[Feishu] Failed to handle message:", err);
    }
  }
}

/** Factory function for ChannelManager registration */
export function createFeishuAdapter(
  config: import("../../types.js").ChannelConfig,
  onMessage: (msg: IncomingMessage) => void,
): ChannelAdapter {
  return new FeishuAdapter(config as FeishuChannelConfig, onMessage);
}
