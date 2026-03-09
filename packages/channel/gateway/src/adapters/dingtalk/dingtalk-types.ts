// Re-export SDK types for convenience
export type {
  RobotMessage,
  RobotTextMessage,
  DWClientDownStream,
} from "dingtalk-stream";

/** DingTalk access token response (for REST API proactive push) */
export interface DingTalkTokenResponse {
  accessToken: string;
  expireIn: number;
}

/** DingTalk sessionWebhook reply body */
export interface WebhookReplyBody {
  msgtype: "text" | "markdown";
  text?: { content: string };
  markdown?: { title: string; text: string };
}
