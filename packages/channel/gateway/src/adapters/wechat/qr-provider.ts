/**
 * WeChat ilink QR provider — adapts the existing ilink QR API onto the shared
 * QR registry skeleton (discussion 028 §4.1). Upstream contract quirks are in
 * gotchas §4: `qrcode` is a token (not a URL), `qrcode_img_content` is the
 * real scan URL, and the status call is a ~45s server long-poll whose timeout
 * (AbortError) simply means "still waiting".
 */
import type { ILinkApi } from "./ilink-api.js";
import type { WeChatChannelConfig } from "../../types.js";
import type { QRProvider, QRPollResult } from "../../qr-registry.js";

export function createWeChatQRProvider(api: ILinkApi): QRProvider {
  return {
    type: "wechat",
    // The status call long-polls server-side; this only spaces out re-issues.
    pollIntervalMs: 1000,

    async start() {
      const resp = await api.getQRCode();
      return {
        upstreamToken: resp.qrcode,
        qrContent: resp.qrcode_img_content || resp.qrcode,
      };
    },

    async poll(upstreamToken): Promise<QRPollResult> {
      let status;
      try {
        status = await api.getQRCodeStatus(upstreamToken);
      } catch (err) {
        // Long-poll timeout is the normal "no news" outcome, not a failure.
        if (err instanceof Error && err.name === "AbortError") {
          return { state: "pending" };
        }
        throw err;
      }

      switch (status.status) {
        case "wait":
          return { state: "pending" };
        case "scaned": // upstream really spells it this way
          return { state: "scanned" };
        case "expired":
          return { state: "expired" };
        case "confirmed":
          return {
            state: "authorized",
            buildConfig: (base): WeChatChannelConfig => ({
              id: base.id,
              type: "wechat",
              name: base.name,
              botToken: status.bot_token,
              ilinkBotId: status.ilink_bot_id,
              ilinkUserId: status.ilink_user_id || "",
              baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com",
              workspaceDir: base.workspaceDir,
              autoConnect: base.autoConnect,
            }),
          };
        default:
          return { state: "pending" };
      }
    },
  };
}
