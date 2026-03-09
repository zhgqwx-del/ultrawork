import {
  DWClient,
  TOPIC_ROBOT,
  EventAck,
} from "dingtalk-stream";
import type { DWClientDownStream, RobotMessage } from "dingtalk-stream";
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelState,
  ChannelStatus,
  IncomingMessage,
} from "../../types.js";
import type { WebhookReplyBody } from "./dingtalk-types.js";
import { TokenManager } from "./token-manager.js";

export class DingTalkAdapter implements ChannelAdapter {
  readonly type = "dingtalk";
  readonly id: string;
  readonly name: string;

  private state: ChannelState = "disconnected";
  private errorMsg?: string;
  private connectedAt?: string;
  private workspaceDir: string;
  private dwClient: DWClient;
  private tokenManager: TokenManager;
  private messageHandler: (msg: IncomingMessage) => void;

  constructor(
    config: ChannelConfig,
    onMessage: (msg: IncomingMessage) => void,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.workspaceDir = config.workspaceDir;
    this.messageHandler = onMessage;
    this.tokenManager = new TokenManager(config.clientId, config.clientSecret);

    this.dwClient = new DWClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      keepAlive: true,
      debug: false,
    });

    // Register robot message callback
    this.dwClient.registerCallbackListener(
      TOPIC_ROBOT,
      (downstream: DWClientDownStream) => {
        this.handleRobotMessage(downstream);
      },
    );
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";
    this.errorMsg = undefined;

    try {
      await this.dwClient.connect();
      this.state = "connected";
      this.connectedAt = new Date().toISOString();
      console.log(`[DingTalk] "${this.name}" connected`);
    } catch (err) {
      this.state = "error";
      this.errorMsg =
        err instanceof Error ? err.message : "Connection failed";
      console.error(`[DingTalk] "${this.name}" connect failed:`, err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.dwClient.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.state = "disconnected";
    this.connectedAt = undefined;
    console.log(`[DingTalk] "${this.name}" disconnected`);
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
    // Proactive push via REST API (requires access_token)
    const token = await this.tokenManager.getToken();
    const robotCode = this.dwClient.getConfig().clientId;

    let resp: Response;
    if (chatId.startsWith("group:")) {
      const conversationId = chatId.slice(6);
      resp = await fetch(
        "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-acs-dingtalk-access-token": token,
          },
          body: JSON.stringify({
            robotCode,
            openConversationId: conversationId,
            msgKey: "sampleMarkdown",
            msgParam: JSON.stringify({ title: "Agent Reply", text: content }),
          }),
        },
      );
    } else {
      resp = await fetch(
        "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-acs-dingtalk-access-token": token,
          },
          body: JSON.stringify({
            robotCode,
            userIds: [chatId],
            msgKey: "sampleMarkdown",
            msgParam: JSON.stringify({ title: "Agent Reply", text: content }),
          }),
        },
      );
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`DingTalk sendMessage failed: ${resp.status} ${detail}`);
    }
  }

  private handleRobotMessage(downstream: DWClientDownStream): void {
    try {
      const robotMsg: RobotMessage = JSON.parse(downstream.data);

      // ACK immediately to prevent server retry
      this.dwClient.socketCallBackResponse(
        downstream.headers.messageId,
        { status: EventAck.SUCCESS },
      );

      // Extract text content
      const text = robotMsg.text?.content?.trim();
      if (!text) {
        console.log(`[DingTalk] Skipping empty message from ${robotMsg.senderNick}`);
        return;
      }

      // Route: single chat → senderId, group chat → "group:{conversationId}"
      const chatId =
        robotMsg.conversationType === "2"
          ? `group:${robotMsg.conversationId}`
          : robotMsg.senderId;

      const sessionWebhook = robotMsg.sessionWebhook;

      const incomingMessage: IncomingMessage = {
        chatId,
        senderId: robotMsg.senderId,
        senderName: robotMsg.senderNick,
        text,
        workspaceDir: this.workspaceDir,
        raw: robotMsg,
        reply: async (content: string) => {
          await this.replyViaWebhook(sessionWebhook, chatId, content);
        },
      };

      console.log(
        `[DingTalk] Message from ${robotMsg.senderNick} (${chatId}): "${text.slice(0, 50)}..."`,
      );

      this.messageHandler(incomingMessage);
    } catch (err) {
      console.error("[DingTalk] Failed to handle robot message:", err);
    }
  }

  /** Reply using the sessionWebhook (valid for ~30 min), fallback to REST API */
  private async replyViaWebhook(
    webhookUrl: string,
    chatId: string,
    content: string,
  ): Promise<void> {
    const body: WebhookReplyBody = {
      msgtype: "markdown",
      markdown: {
        title: "Agent Reply",
        text: content,
      },
    };

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(
        `[DingTalk] Webhook reply failed: ${resp.status} ${detail}`,
      );

      // Fallback to proactive push if webhook expired
      if (resp.status === 400 || resp.status === 403) {
        console.log("[DingTalk] Webhook expired, falling back to REST API push");
        try {
          await this.sendMessage(chatId, content);
          console.log("[DingTalk] REST API fallback succeeded");
        } catch (fallbackErr) {
          console.error("[DingTalk] REST API fallback also failed:", fallbackErr);
        }
      }
    }
  }
}

/** Factory function for ChannelManager registration */
export function createDingTalkAdapter(
  config: ChannelConfig,
  onMessage: (msg: IncomingMessage) => void,
): ChannelAdapter {
  return new DingTalkAdapter(config, onMessage);
}
