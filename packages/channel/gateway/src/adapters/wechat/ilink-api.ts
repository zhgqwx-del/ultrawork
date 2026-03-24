/**
 * ilink bot HTTP API client.
 * Handles all communication with the Tencent ilink backend.
 */
import type {
  QRCodeResponse,
  QRStatusResponse,
  GetUpdatesResponse,
  SendMessageRequest,
  SendMessageResponse,
  GetConfigResponse,
  MessageItem,
  SendMsg,
} from "./types.js";
import {
  ITEM_TYPE_TEXT,
  MSG_TYPE_BOT,
  MSG_STATE_FINISH,
} from "./types.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.0";

/** Generate a random base64-encoded uint32 for X-WECHAT-UIN header */
function randomUIN(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf));
}

/** Generate a unique client ID for message dedup */
function clientId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class ILinkApi {
  private uin: string;

  constructor(
    private botToken: string = "",
    private baseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.uin = randomUIN();
  }

  /** Update credentials after QR login confirmation */
  setCredentials(botToken: string, baseUrl: string): void {
    this.botToken = botToken;
    this.baseUrl = baseUrl;
  }

  // ---- QR Code (unauthenticated) ----

  async getQRCode(): Promise<QRCodeResponse> {
    const url = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`get_bot_qrcode failed: ${resp.status}`);
    }
    return resp.json() as Promise<QRCodeResponse>;
  }

  async getQRCodeStatus(qrcodeToken: string): Promise<QRStatusResponse> {
    const url = `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeToken)}`;
    // Long-poll with 40s timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`get_qrcode_status failed: ${resp.status}`);
      }
      return resp.json() as Promise<QRStatusResponse>;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Authenticated API ----

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${this.botToken}`,
      "X-WECHAT-UIN": this.uin,
    };
  }

  async getUpdates(cursor: string): Promise<GetUpdatesResponse> {
    const url = `${this.baseUrl}/ilink/bot/getupdates`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          get_updates_buf: cursor,
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`getupdates failed: ${resp.status} ${text}`);
      }
      return resp.json() as Promise<GetUpdatesResponse>;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendTextMessage(
    toUserId: string,
    ilinkBotId: string,
    text: string,
    contextToken: string = "",
  ): Promise<SendMessageResponse> {
    const url = `${this.baseUrl}/ilink/bot/sendmessage`;
    const items: MessageItem[] = [
      { type: ITEM_TYPE_TEXT, text_item: { text } },
    ];
    const msg: SendMsg = {
      from_user_id: ilinkBotId,
      to_user_id: toUserId,
      client_id: clientId(),
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: items,
      context_token: contextToken,
    };
    const body: SendMessageRequest = {
      msg,
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`sendmessage failed: ${resp.status} ${detail}`);
    }
    return resp.json() as Promise<SendMessageResponse>;
  }

  async getConfig(
    ilinkUserId: string,
    contextToken: string = "",
  ): Promise<GetConfigResponse> {
    const url = `${this.baseUrl}/ilink/bot/getconfig`;
    const resp = await fetch(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        ilink_user_id: ilinkUserId,
        context_token: contextToken,
        base_info: {},
      }),
    });
    if (!resp.ok) {
      throw new Error(`getconfig failed: ${resp.status}`);
    }
    return resp.json() as Promise<GetConfigResponse>;
  }
}

/** Shared ILinkApi instance for QR code operations (unauthenticated) */
export const qrApi = new ILinkApi();
