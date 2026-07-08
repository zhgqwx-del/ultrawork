/**
 * QR login session registry — one shared skeleton for every scan-to-bind
 * channel flow (wechat ilink, dingtalk/feishu device flows, wecom ai/qc).
 *
 * Design (discussion 028 §4.1): the gateway polls upstream in the background
 * and caches the outcome; the frontend only ever reads the cached snapshot.
 * This is load-bearing for device flows: their poll endpoint delivers the
 * client_secret exactly once, so the credential must be persisted the moment
 * it arrives — never proxied through a frontend HTTP response that may be
 * dropped — and upstream must not be polled more often than its mandated
 * interval (dingtalk: `interval: 2` seconds, measured 2026-07-08).
 */
import { randomBytes } from "crypto";
import type { ChannelManager } from "./channel-manager.js";
import type { ChannelConfig } from "./types.js";

export type QRSessionState =
  | "pending"    // waiting for scan
  | "scanned"    // scanned, waiting for in-app confirmation
  | "authorized" // credentials delivered and channel persisted
  | "expired"
  | "denied"     // user rejected / org policy refused
  | "error";

/** Fields the frontend supplies when starting a session. */
export interface QRSessionRequest {
  name: string;
  workspaceDir: string;
  autoConnect: boolean;
}

/** Base handed to the provider when credentials arrive. */
export interface QRConfigBase extends QRSessionRequest {
  id: string;
}

/** One upstream poll outcome. */
export type QRPollResult =
  | { state: "pending" | "scanned" | "expired" }
  | { state: "denied"; error?: string }
  | { state: "authorized"; buildConfig: (base: QRConfigBase) => ChannelConfig };

export interface QRProvider {
  readonly type: string;
  /** Minimum delay between upstream polls (device flows mandate one). */
  readonly pollIntervalMs: number;
  /** May return a per-session pollIntervalMs override — device flows hand the
   * mandated interval back in the begin/start response. */
  start(): Promise<{ upstreamToken: string; qrContent: string; expiresInMs?: number; pollIntervalMs?: number }>;
  /** Poll upstream once. Throw for transient failures (registry retries). */
  poll(upstreamToken: string): Promise<QRPollResult>;
}

export interface QRSessionSnapshot {
  token: string;
  type: string;
  state: QRSessionState;
  qrContent: string;
  channelId?: string;
  error?: string;
}

interface QRSession extends QRSessionSnapshot {
  upstreamToken: string;
  request: QRSessionRequest;
  pollIntervalMs: number;
  createdAt: number;
  expiresAt: number;
  finishedAt?: number;
  cancelled: boolean;
}

const TERMINAL: ReadonlySet<QRSessionState> = new Set(["authorized", "expired", "denied", "error"]);
/** Re-use an in-flight session for an identical request within this window
 * (guards React StrictMode double-mount from opening two device flows). */
const DEDUP_WINDOW_MS = 15_000;
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const FINISHED_RETENTION_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

function generateToken(): string {
  return `qr_${randomBytes(8).toString("hex")}`;
}

function generateChannelId(): string {
  return `ch_${randomBytes(6).toString("hex")}`;
}

export class QRRegistry {
  private providers = new Map<string, QRProvider>();
  private sessions = new Map<string, QRSession>();

  constructor(private manager: ChannelManager) {}

  registerProvider(provider: QRProvider): void {
    this.providers.set(provider.type, provider);
  }

  hasProvider(type: string): boolean {
    return this.providers.has(type);
  }

  /** Start (or reuse) a QR session and kick off the background poll loop. */
  async start(type: string, request: QRSessionRequest): Promise<QRSessionSnapshot> {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`No QR provider registered for type "${type}"`);
    }
    this.cleanup();

    const existing = this.findReusable(type, request);
    if (existing) return this.snapshot(existing.token)!;

    const started = await provider.start();
    const now = Date.now();
    const session: QRSession = {
      token: generateToken(),
      type,
      state: "pending",
      qrContent: started.qrContent,
      upstreamToken: started.upstreamToken,
      request,
      pollIntervalMs: started.pollIntervalMs ?? provider.pollIntervalMs,
      createdAt: now,
      expiresAt: now + (started.expiresInMs ?? DEFAULT_SESSION_TTL_MS),
      cancelled: false,
    };
    this.sessions.set(session.token, session);
    void this.runLoop(session, provider);
    return this.snapshot(session.token)!;
  }

  getSnapshot(token: string): QRSessionSnapshot | undefined {
    return this.snapshot(token);
  }

  /** Cancel a session: stops the poll loop and forgets it immediately.
   * Note: an upstream device-flow app that was already half-created by a scan
   * cannot be rolled back from here — cancel only stops our side. */
  cancel(token: string): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;
    session.cancelled = true;
    this.sessions.delete(token);
    return true;
  }

  /** Stop every loop (test teardown / gateway shutdown). */
  stopAll(): void {
    for (const session of this.sessions.values()) session.cancelled = true;
    this.sessions.clear();
  }

  private findReusable(type: string, request: QRSessionRequest): QRSession | undefined {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (
        s.type === type &&
        !TERMINAL.has(s.state) &&
        !s.cancelled &&
        s.request.name === request.name &&
        s.request.workspaceDir === request.workspaceDir &&
        now - s.createdAt < DEDUP_WINDOW_MS
      ) {
        return s;
      }
    }
    return undefined;
  }

  private snapshot(token: string): QRSessionSnapshot | undefined {
    const s = this.sessions.get(token);
    if (!s) return undefined;
    return {
      token: s.token,
      type: s.type,
      state: s.state,
      qrContent: s.qrContent,
      channelId: s.channelId,
      error: s.error,
    };
  }

  private finish(session: QRSession, state: QRSessionState, error?: string): void {
    session.state = state;
    if (error) session.error = error;
    session.finishedAt = Date.now();
  }

  private async runLoop(session: QRSession, provider: QRProvider): Promise<void> {
    let consecutiveErrors = 0;
    while (!session.cancelled && !TERMINAL.has(session.state)) {
      if (Date.now() > session.expiresAt) {
        this.finish(session, "expired");
        return;
      }

      let result: QRPollResult;
      try {
        result = await provider.poll(session.upstreamToken);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          this.finish(session, "error", err instanceof Error ? err.message : "QR poll failed");
          return;
        }
        await this.sleep(session, session.pollIntervalMs);
        continue;
      }

      if (session.cancelled) return;

      switch (result.state) {
        case "pending":
        case "scanned":
          session.state = result.state;
          break;
        case "expired":
          this.finish(session, "expired");
          return;
        case "denied":
          this.finish(session, "denied", result.error);
          return;
        case "authorized": {
          // One-shot credential: persist BEFORE exposing the state. If
          // persistence fails the secret is already consumed upstream — the
          // only honest outcome is an error the user can retry from scratch.
          try {
            const config = result.buildConfig({ ...session.request, id: generateChannelId() });
            await this.manager.addChannel(config);
            session.channelId = config.id;
            this.finish(session, "authorized");
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to persist channel";
            console.error(`[QR:${session.type}] credential delivered but channel persist failed:`, msg);
            this.finish(session, "error", msg);
          }
          return;
        }
      }

      await this.sleep(session, session.pollIntervalMs);
    }
  }

  private sleep(session: QRSession, ms: number): Promise<void> {
    // Chunked so cancel() takes effect within ≤500ms even for long intervals.
    return new Promise((resolve) => {
      const step = Math.min(ms, 500);
      let remaining = ms;
      const tick = () => {
        if (session.cancelled || remaining <= 0) return resolve();
        const wait = Math.min(step, remaining);
        remaining -= wait;
        setTimeout(tick, wait);
      };
      tick();
    });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [token, s] of this.sessions) {
      const finishedLongAgo = s.finishedAt !== undefined && now - s.finishedAt > FINISHED_RETENTION_MS;
      const ancient = now - s.createdAt > DEFAULT_SESSION_TTL_MS + FINISHED_RETENTION_MS;
      if (finishedLongAgo || ancient) {
        s.cancelled = true;
        this.sessions.delete(token);
      }
    }
  }
}
