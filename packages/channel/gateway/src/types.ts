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

export interface ChannelConfig {
  id: string;
  type: "dingtalk"; // extensible for future adapters
  name: string;
  clientId: string;
  clientSecret: string;
  /** Workspace directory this channel is bound to */
  workspaceDir: string;
  autoConnect: boolean;
}

export interface ChannelsStore {
  channels: ChannelConfig[];
}

/** Message received from a channel adapter */
export interface IncomingMessage {
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  /** Workspace directory this channel is bound to */
  workspaceDir: string;
  /** Raw platform-specific data */
  raw: unknown;
  /** Callback to reply to this message */
  reply: (content: string) => Promise<void>;
}

/** Factory function to create an adapter from config */
export type AdapterFactory = (
  config: ChannelConfig,
  onMessage: (msg: IncomingMessage) => void,
) => ChannelAdapter;
