/** Channel adapter interface — each messaging platform implements this */
export interface ChannelAdapter {
  readonly type: string;
  readonly name: string;
  readonly id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ChannelStatus;
  /** Send a message to a specific chat */
  sendMessage(chatId: string, content: string): Promise<void>;
}

export type ChannelState = "disconnected" | "connecting" | "connected" | "error";

export interface ChannelStatus {
  id: string;
  type: string;
  name: string;
  state: ChannelState;
  error?: string;
  connectedAt?: string;
}

// --- Channel config discriminated union ---

interface ChannelConfigBase {
  id: string;
  name: string;
  /** Workspace directory this channel is bound to */
  workspaceDir: string;
  autoConnect: boolean;
}

export interface DingTalkChannelConfig extends ChannelConfigBase {
  type: "dingtalk";
  clientId: string;
  clientSecret: string;
}

export interface WeChatChannelConfig extends ChannelConfigBase {
  type: "wechat";
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
}

export interface WeComChannelConfig extends ChannelConfigBase {
  type: "wecom";
  botId: string;
  secret: string;
}

export interface FeishuChannelConfig extends ChannelConfigBase {
  type: "feishu";
  appId: string;
  appSecret: string;
  /** Feishu (CN) vs Lark (intl) tenants live on different API domains */
  domain: "feishu" | "lark";
}

export type ChannelConfig =
  | DingTalkChannelConfig
  | WeChatChannelConfig
  | WeComChannelConfig
  | FeishuChannelConfig;

export interface ChannelsStore {
  channels: ChannelConfig[];
}

/** Message received from a channel adapter */
export interface IncomingMessage {
  chatId: string;
  senderId: string;
  senderName: string;
  /** Channel type for display labeling (e.g. session title prefix) */
  channelType: string;
  text: string;
  /** Workspace directory this channel is bound to */
  workspaceDir: string;
  /** Raw platform-specific data */
  raw: unknown;
  /** Callback to reply to this message */
  reply: (content: string) => Promise<void>;
  /** Optional: send typing indicator (true=start, false=stop) */
  onTyping?: (typing: boolean) => void;
}

/** Factory function to create an adapter from config */
export type AdapterFactory = (
  config: ChannelConfig,
  onMessage: (msg: IncomingMessage) => void,
) => ChannelAdapter;
