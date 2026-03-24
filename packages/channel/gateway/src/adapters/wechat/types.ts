/** ilink bot API types */

// --- Message item types ---
export const ITEM_TYPE_TEXT = 1;
export const ITEM_TYPE_IMAGE = 2;
export const ITEM_TYPE_VOICE = 3;
export const ITEM_TYPE_FILE = 4;
export const ITEM_TYPE_VIDEO = 5;

// --- Message types ---
export const MSG_TYPE_USER = 1;
export const MSG_TYPE_BOT = 2;

// --- Message states ---
export const MSG_STATE_NEW = 0;
export const MSG_STATE_GENERATING = 1;
export const MSG_STATE_FINISH = 2;

// --- Base ---
export interface BaseInfo {
  channel_version?: string;
}

// --- QR Code ---
export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token: string;
  ilink_bot_id: string;
  baseurl: string;
  ilink_user_id: string;
}

// --- Messages ---
export interface TextItem {
  text: string;
}

export interface VoiceItem {
  text?: string; // STT transcription
  media?: MediaInfo;
}

export interface ImageItem {
  url?: string;
  media?: MediaInfo;
  mid_size?: number;
}

export interface VideoItem {
  media?: MediaInfo;
  video_size?: number;
}

export interface FileItem {
  media?: MediaInfo;
  file_name?: string;
  len?: string;
}

export interface MediaInfo {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: number;
}

export interface MessageItem {
  type: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  video_item?: VideoItem;
  file_item?: FileItem;
}

export interface WeixinMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  message_state: number;
  item_list: MessageItem[];
  context_token: string;
}

// --- GetUpdates ---
export interface GetUpdatesRequest {
  get_updates_buf: string;
  base_info: BaseInfo;
}

export interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs: WeixinMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
}

// --- SendMessage ---
export interface SendMsg {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  message_type: number;
  message_state: number;
  item_list: MessageItem[];
  context_token: string;
}

export interface SendMessageRequest {
  msg: SendMsg;
  base_info: BaseInfo;
}

export interface SendMessageResponse {
  ret: number;
  errmsg?: string;
}

// --- GetConfig ---
export interface GetConfigRequest {
  ilink_user_id: string;
  context_token: string;
  base_info: BaseInfo;
}

export interface GetConfigResponse {
  ret: number;
  errmsg?: string;
  typing_ticket?: string;
}

// --- Credentials (stored in channel config) ---
export interface WeChatCredentials {
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
}
