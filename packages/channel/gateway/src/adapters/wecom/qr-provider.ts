/**
 * WeCom (企业微信) scan-to-create QR provider — the `ai/qc` flow the official
 * wecom-cli uses (source: @wecom/wecom-openclaw-cli dist/utils/qrcode.js;
 * cross-checked by live curl 2026-07-08, gotchas §4):
 *   GET /ai/qc/generate?source=wecom-cli&plat=N → {data:{scode, auth_url}}
 *   GET /ai/qc/query_result?scode=…            → {data:{status, bot_info?}}
 * Scanning auth_url in the WeCom app offers "一键创建智能机器人"; `success`
 * delivers bot_info{botid, secret} — always a NEW bot (no bind-existing path).
 *
 * Contract quirks: a bogus/expired scode still answers `pending` (no error
 * signal), so expiry is purely local — the CLI uses 5 minutes, we mirror it.
 * Only `success` is treated as terminal, matching the official CLI.
 */
import type { WeComChannelConfig } from "../../types.js";
import type { QRProvider, QRPollResult } from "../../qr-registry.js";

const BASE_URL = process.env.WECOM_QC_BASE_URL || "https://work.weixin.qq.com";
const SOURCE = process.env.WECOM_QC_SOURCE || "wecom-cli";
const SESSION_TTL_MS = 5 * 60 * 1000; // official CLI POLL_TIMEOUT
const POLL_INTERVAL_MS = 3000; // official CLI POLL_INTERVAL

function platCode(): number {
  switch (process.platform) {
    case "darwin": return 1;
    case "win32": return 2;
    case "linux": return 3;
    default: return 0;
  }
}

interface GenerateResponse {
  data?: { scode?: string; auth_url?: string };
}

interface QueryResponse {
  data?: {
    status?: string;
    bot_info?: { botid?: string; secret?: string };
  };
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`WeCom QR request failed: HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export function createWeComQRProvider(): QRProvider {
  return {
    type: "wecom",
    pollIntervalMs: POLL_INTERVAL_MS,

    async start() {
      const resp = await getJson<GenerateResponse>(
        `${BASE_URL}/ai/qc/generate?source=${SOURCE}&plat=${platCode()}`,
      );
      const scode = resp.data?.scode;
      const authUrl = resp.data?.auth_url;
      if (!scode || !authUrl) {
        throw new Error("WeCom QR generate returned no scode/auth_url");
      }
      return {
        upstreamToken: scode,
        qrContent: authUrl,
        // Desktop-browser landing page that shows the same QR (the CLI prints
        // it as the "也可打开二维码链接扫码" alternative).
        browserUrl: `${BASE_URL}/ai/qc/gen?source=${SOURCE}&scode=${encodeURIComponent(scode)}`,
        expiresInMs: SESSION_TTL_MS,
      };
    },

    async poll(scode): Promise<QRPollResult> {
      const resp = await getJson<QueryResponse>(
        `${BASE_URL}/ai/qc/query_result?scode=${encodeURIComponent(scode)}`,
      );
      const status = resp.data?.status;

      if (status === "success") {
        const bot = resp.data?.bot_info;
        if (!bot?.botid || !bot?.secret) {
          console.error(
            `[QR:wecom] success payload missing bot_info; keys: ${Object.keys(resp.data ?? {}).join(",")}`,
          );
          return { state: "denied", error: "Scan succeeded but no bot credentials returned" };
        }
        const { botid, secret } = bot;
        return {
          state: "authorized",
          buildConfig: (base): WeComChannelConfig => ({
            id: base.id,
            type: "wecom",
            name: base.name,
            botId: botid,
            secret,
            workspaceDir: base.workspaceDir,
            autoConnect: base.autoConnect,
          }),
        };
      }

      // Everything else (pending / unknown / bogus scode) keeps waiting —
      // upstream never signals expiry; the registry's local TTL handles it.
      return { state: "pending" };
    },
  };
}
