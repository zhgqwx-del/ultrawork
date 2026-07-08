/**
 * Feishu (飞书/Lark) scan-to-create QR provider — the PersonalAgent app
 * registration device flow the official lark-cli / openclaw-lark plugin use
 * (source-anchored to openclaw-lark app-registration.ts; endpoint is an OAuth
 * extension on the accounts domain, not in the public open-apis catalog):
 *   POST accounts.feishu.cn/oauth/v1/app/registration (form-encoded)
 *     {action:"init"}  → {nonce, supported_auth_methods}
 *     {action:"begin", archetype:"PersonalAgent", auth_method:"client_secret",
 *      request_user_info:"open_id"} → {device_code, verification_uri_complete,
 *      user_code, interval(s), expire_in(s)}
 *     {action:"poll", device_code} → {client_id, client_secret, user_info?}
 *       or {error: authorization_pending | slow_down | access_denied |
 *       expired_token}, delivered with a 4xx status + JSON body.
 *
 * Contract quirks: pending states arrive as HTTP 4xx WITH a JSON body (do not
 * treat !ok as failure); `slow_down` mandates +5s on the poll interval;
 * `user_info.tenant_brand === "lark"` means the credential must be fetched
 * from accounts.larksuite.com instead — per-device-code state below carries
 * both adjustments across polls, and the resolved brand is persisted into the
 * channel config (WS/send domains differ too).
 */
import type { FeishuChannelConfig } from "../../types.js";
import type { QRProvider, QRPollResult } from "../../qr-registry.js";

const FEISHU_ACCOUNTS_URL = process.env.FEISHU_ACCOUNTS_BASE_URL || "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = process.env.LARK_ACCOUNTS_BASE_URL || "https://accounts.larksuite.com";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const DEFAULT_INTERVAL_S = 5;
const DEFAULT_EXPIRE_S = 600;

type FeishuDomain = "feishu" | "lark";

interface InitResponse {
  nonce?: string;
  supported_auth_methods?: string[];
}

interface BeginResponse {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  interval?: number;
  expire_in?: number;
}

interface PollResponse {
  client_id?: string;
  client_secret?: string;
  user_info?: { open_id?: string; tenant_brand?: FeishuDomain };
  error?: string;
  error_description?: string;
}

/** Per-device-code flow state that must survive across poll calls. */
interface FlowState {
  domain: FeishuDomain;
  extraDelayMs: number;
  createdAt: number;
}

async function postRegistration<T>(domain: FeishuDomain, body: Record<string, string>): Promise<T> {
  const base = domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
  const resp = await fetch(`${base}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  // Pending/denied poll states come back as 4xx with a JSON body — parse
  // before deciding anything on the status code.
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Feishu registration ${body.action} failed: HTTP ${resp.status}`);
  }
}

export function createFeishuQRProvider(): QRProvider {
  const flows = new Map<string, FlowState>();

  const pruneFlows = () => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, flow] of flows) {
      if (flow.createdAt < cutoff) flows.delete(key);
    }
  };

  return {
    type: "feishu",
    pollIntervalMs: DEFAULT_INTERVAL_S * 1000,

    async start() {
      pruneFlows();
      const init = await postRegistration<InitResponse>("feishu", { action: "init" });
      if (!init.supported_auth_methods?.includes("client_secret")) {
        throw new Error("Feishu registration environment does not support client_secret auth");
      }
      const begin = await postRegistration<BeginResponse>("feishu", {
        action: "begin",
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id",
      });
      if (!begin.device_code || !begin.verification_uri_complete) {
        throw new Error("Feishu registration begin returned no device_code/verification URL");
      }
      flows.set(begin.device_code, { domain: "feishu", extraDelayMs: 0, createdAt: Date.now() });
      return {
        upstreamToken: begin.device_code,
        qrContent: begin.verification_uri_complete,
        expiresInMs: (begin.expire_in ?? DEFAULT_EXPIRE_S) * 1000,
        pollIntervalMs: Math.max((begin.interval ?? DEFAULT_INTERVAL_S) * 1000, 2000),
      };
    },

    async poll(deviceCode): Promise<QRPollResult> {
      const flow = flows.get(deviceCode) ?? { domain: "feishu" as FeishuDomain, extraDelayMs: 0, createdAt: Date.now() };
      flows.set(deviceCode, flow);

      // slow_down accumulates extra delay on top of the registry interval
      if (flow.extraDelayMs > 0) {
        await new Promise((r) => setTimeout(r, flow.extraDelayMs));
      }

      const resp = await postRegistration<PollResponse>(flow.domain, {
        action: "poll",
        device_code: deviceCode,
      });

      // Lark tenants deliver the secret only from the lark accounts domain —
      // switch and let the next poll pick it up there.
      if (resp.user_info?.tenant_brand === "lark" && flow.domain !== "lark") {
        flow.domain = "lark";
        if (!(resp.client_id && resp.client_secret)) {
          return { state: "scanned" };
        }
      }

      if (resp.client_id && resp.client_secret) {
        const { client_id, client_secret } = resp;
        const domain = flow.domain;
        flows.delete(deviceCode);
        return {
          state: "authorized",
          buildConfig: (base): FeishuChannelConfig => ({
            id: base.id,
            type: "feishu",
            name: base.name,
            appId: client_id,
            appSecret: client_secret,
            domain,
            workspaceDir: base.workspaceDir,
            autoConnect: base.autoConnect,
          }),
        };
      }

      switch (resp.error) {
        case undefined:
        case "authorization_pending":
          return { state: "pending" };
        case "slow_down":
          flow.extraDelayMs += 5000;
          return { state: "pending" };
        case "access_denied":
          flows.delete(deviceCode);
          return { state: "denied", error: resp.error_description || "Authorization denied" };
        case "expired_token":
          flows.delete(deviceCode);
          return { state: "expired" };
        default:
          flows.delete(deviceCode);
          return { state: "denied", error: `${resp.error}: ${resp.error_description ?? "unknown"}` };
      }
    },
  };
}
