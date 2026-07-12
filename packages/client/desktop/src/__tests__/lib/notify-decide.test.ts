import { describe, it, expect, beforeEach } from "vitest"
import { decideChannels, type NotifyContext } from "@/lib/notifications/notify-decide"
import {
  markLocallyPrompted,
  consumeLocallyPrompted,
  isLocallyPrompted,
  forgetLocallyPrompted,
  __resetNotifyRegistryForTest,
} from "@/lib/notifications/notify-registry"

const ALL_ON = { sound: true, system: true, flash: true }

function ctx(over: Partial<NotifyContext> = {}): NotifyContext {
  return {
    focused: false,
    viewingSessionId: undefined,
    locallyPrompted: true,
    alreadyAlerted: false,
    settings: ALL_ON,
    ...over,
  }
}

describe("decideChannels", () => {
  it("announces a completed turn on all three channels when the user is away", () => {
    expect(decideChannels({ kind: "completed", sessionId: "s1" }, ctx())).toEqual(ALL_ON)
  })

  it("stays silent for sessions the desktop user never prompted (IM channel turns, delegate children)", () => {
    // The single rule that keeps WeChat/DingTalk/Feishu traffic and sub-agent
    // sessions quiet — both emit the same session.status:idle we key on.
    const channels = decideChannels({ kind: "completed", sessionId: "im-1" }, ctx({ locallyPrompted: false }))
    expect(channels).toEqual({ sound: false, system: false, flash: false })
  })

  it("stays silent when the user is focused ON the session that finished", () => {
    const channels = decideChannels(
      { kind: "completed", sessionId: "s1" },
      ctx({ focused: true, viewingSessionId: "s1" }),
    )
    expect(channels).toEqual({ sound: false, system: false, flash: false })
  })

  it("still announces a background session while the window is focused on ANOTHER session", () => {
    // The reference implementation we were shown gates purely on window focus and
    // cannot do this — you would never learn that session B finished.
    const channels = decideChannels(
      { kind: "completed", sessionId: "s2" },
      ctx({ focused: true, viewingSessionId: "s1" }),
    )
    expect(channels).toEqual(ALL_ON)
  })

  it("announces a session that finished while the user sat on a non-session route", () => {
    const channels = decideChannels(
      { kind: "completed", sessionId: "s1" },
      ctx({ focused: true, viewingSessionId: undefined }),
    )
    expect(channels).toEqual(ALL_ON)
  })

  it("announces failures, not just completions", () => {
    expect(decideChannels({ kind: "failed", sessionId: "s1" }, ctx())).toEqual(ALL_ON)
  })

  describe("attention (permission / question)", () => {
    it("announces the first request", () => {
      expect(decideChannels({ kind: "attention", sessionId: "s1" }, ctx())).toEqual(ALL_ON)
    })

    it("does not announce a second request until the user has been back", () => {
      // `permission: ask` asks once per bash call. Without this, ten minutes away =
      // a dozen banners and a dozen dock bounces (discussions/036 §2.5).
      const channels = decideChannels({ kind: "attention", sessionId: "s1" }, ctx({ alreadyAlerted: true }))
      expect(channels).toEqual({ sound: false, system: false, flash: false })
    })

    it("throttles per session — a second session's question still gets through", () => {
      // The throttle key is the session, so a busy session cannot mute a quiet one.
      const s1 = decideChannels({ kind: "attention", sessionId: "s1" }, ctx({ alreadyAlerted: true }))
      const s2 = decideChannels({ kind: "attention", sessionId: "s2" }, ctx({ alreadyAlerted: false }))
      expect(s1.system).toBe(false)
      expect(s2.system).toBe(true)
    })

    it("does NOT throttle completions — the throttle is only for the repeatable event", () => {
      const channels = decideChannels({ kind: "completed", sessionId: "s1" }, ctx({ alreadyAlerted: true }))
      expect(channels).toEqual(ALL_ON)
    })
  })

  describe("settings", () => {
    it("honours each switch independently", () => {
      const only = (k: "sound" | "system" | "flash") =>
        decideChannels(
          { kind: "completed", sessionId: "s1" },
          ctx({ settings: { sound: false, system: false, flash: false, [k]: true } }),
        )
      expect(only("sound")).toEqual({ sound: true, system: false, flash: false })
      expect(only("system")).toEqual({ sound: false, system: true, flash: false })
      expect(only("flash")).toEqual({ sound: false, system: false, flash: true })
    })

    it("all three off = fully silent", () => {
      const channels = decideChannels(
        { kind: "attention", sessionId: "s1" },
        ctx({ settings: { sound: false, system: false, flash: false } }),
      )
      expect(channels).toEqual({ sound: false, system: false, flash: false })
    })
  })
})

describe("notify-registry", () => {
  beforeEach(__resetNotifyRegistryForTest)

  it("owes exactly one completion per locally-sent prompt", () => {
    markLocallyPrompted("s1")
    expect(consumeLocallyPrompted("s1")).toBe(true)
    // A second idle for the same session (a stray event, a re-emitted status) must
    // not produce a second notification.
    expect(consumeLocallyPrompted("s1")).toBe(false)
  })

  it("never owes anything for a session the user did not prompt", () => {
    expect(consumeLocallyPrompted("im-session")).toBe(false)
  })

  it("peeking (the attention path) leaves the completion still owed", () => {
    markLocallyPrompted("s1")
    expect(isLocallyPrompted("s1")).toBe(true)
    expect(isLocallyPrompted("s1")).toBe(true)
    // The turn resumes after the user answers, and its completion is still announced.
    expect(consumeLocallyPrompted("s1")).toBe(true)
  })

  it("forgets a stopped / failed-to-send turn without announcing it", () => {
    markLocallyPrompted("s1")
    forgetLocallyPrompted("s1")
    expect(consumeLocallyPrompted("s1")).toBe(false)
  })
})
