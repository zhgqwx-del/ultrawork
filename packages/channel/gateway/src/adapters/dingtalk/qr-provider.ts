/**
 * DingTalk registration device-flow QR provider (discussion 028 §1.1/B1).
 *
 * Upstream: the app-registration bootstrap DingTalk ships for AI-agent tools
 * (source: DingTalk-Real-AI/dingtalk-openclaw-connector, device-auth.ts) —
 * NOT documented on the open platform. Contract cross-checked by live curl
 * (2026-07-08, gotchas §4):
 *   init  POST /app/registration/init  {source}        → {nonce, expires_in:300}
 *   begin POST /app/registration/begin {nonce, source} → {device_code(7200s),
 *         interval:2, user_code, verification_uri_complete}
 *   poll  POST /app/registration/poll  {device_code}   → {status: WAITING|
 *         SUCCESS|FAIL|EXPIRED, ...}; FAIL arrives as errcode:0 + fail_reason
 *         (an HTTP-level error is NOT how failures are signalled).
 * The user scans verification_uri_complete and taps "一键创建新机器人" (or
 * binds an existing bot); SUCCESS delivers client_id/client_secret exactly
 * once — the registry persists them immediately.
 *
 * Env overrides mirror the official connector: DINGTALK_REGISTRATION_BASE_URL
 * and DINGTALK_REGISTRATION_SOURCE (default source is the official one; a
 * branded source needs DingTalk's sign-off — 028 D6).
 */
import type { DingTalkChannelConfig } from "../../types.js";
import type { QRProvider, QRPollResult } from "../../qr-registry.js";

const BASE_URL = process.env.DINGTALK_REGISTRATION_BASE_URL || "https://oapi.dingtalk.com";
const SOURCE = process.env.DINGTALK_REGISTRATION_SOURCE || "DING_DWS_CLAW";

interface InitResponse {
  errcode: number;
  errmsg: string;
  nonce: string;
}

interface BeginResponse {
  errcode: number;
  errmsg: string;
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface PollResponse {
  errcode: number;
  errmsg: string;
  status: "WAITING" | "SUCCESS" | "FAIL" | "EXPIRED";
  fail_reason?: string;
  client_id?: string;
  client_secret?: string;
}

async function post<T extends { errcode: number; errmsg: string }>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`${path} failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as T;
  if (data.errcode !== 0) {
    throw new Error(`${path} failed: ${data.errmsg} (errcode ${data.errcode})`);
  }
  return data;
}

export function createDingTalkQRProvider(): QRProvider {
  return {
    type: "dingtalk",
    pollIntervalMs: 2000, // fallback; begin's `interval` overrides per session

    async start() {
      const init = await post<InitResponse>("/app/registration/init", { source: SOURCE });
      const begin = await post<BeginResponse>("/app/registration/begin", {
        nonce: init.nonce,
        source: SOURCE,
      });
      // Undocumented contract — guard against field drift (a missing
      // `interval` would otherwise propagate NaN into the poll loop).
      const expiresIn = Number.isFinite(begin.expires_in) ? begin.expires_in : 7200;
      const interval = Number.isFinite(begin.interval) ? begin.interval : 2;
      return {
        upstreamToken: begin.device_code,
        qrContent: begin.verification_uri_complete,
        expiresInMs: expiresIn * 1000,
        pollIntervalMs: Math.max(interval * 1000, 2000),
      };
    },

    async poll(deviceCode): Promise<QRPollResult> {
      const resp = await post<PollResponse>("/app/registration/poll", { device_code: deviceCode });

      switch (resp.status) {
        case "WAITING":
          // The flow has no distinct "scanned" signal — stays pending until
          // the user confirms in-app.
          return { state: "pending" };
        case "EXPIRED":
          return { state: "expired" };
        case "FAIL":
          return { state: "denied", error: resp.fail_reason || "Authorization failed" };
        case "SUCCESS": {
          if (!resp.client_id || !resp.client_secret) {
            // Field drift on the undocumented contract — surface loudly with
            // key names (never values) so the payload can be re-anchored.
            console.error(
              `[QR:dingtalk] SUCCESS payload missing credentials; keys: ${Object.keys(resp).join(",")}`,
            );
            return { state: "denied", error: "Registration succeeded but no credentials returned" };
          }
          const { client_id, client_secret } = resp;
          return {
            state: "authorized",
            buildConfig: (base): DingTalkChannelConfig => ({
              id: base.id,
              type: "dingtalk",
              name: base.name,
              clientId: client_id,
              clientSecret: client_secret,
              workspaceDir: base.workspaceDir,
              autoConnect: base.autoConnect,
            }),
          };
        }
        default:
          return { state: "pending" };
      }
    },
  };
}
