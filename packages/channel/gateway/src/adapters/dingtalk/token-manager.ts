// TODO Step 4: Token manager for DingTalk REST API (proactive push)
// - Cache access_token with TTL
// - Refresh 60s before expiry
// - Used for oToMessages/batchSend and groupMessages/send

export class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  /** Dedup concurrent refresh calls */
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) {
      return this.token;
    }
    // Dedup: if a refresh is already in-flight, reuse it
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refresh(): Promise<string> {
    const resp = await fetch(
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appKey: this.clientId,
          appSecret: this.clientSecret,
        }),
      },
    );
    if (!resp.ok) {
      throw new Error(`DingTalk token refresh failed: ${resp.status}`);
    }
    const data = (await resp.json()) as {
      accessToken: string;
      expireIn: number;
    };
    this.token = data.accessToken;
    this.expiresAt = Date.now() + data.expireIn * 1000;
    return this.token;
  }
}
