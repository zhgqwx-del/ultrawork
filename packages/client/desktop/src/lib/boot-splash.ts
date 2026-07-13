// Startup splash lifecycle (discussions/038).
//
// The splash itself lives in `index.html` — plain markup with inline CSS, so the
// webview can paint it on its very first frame, long before this bundle has parsed.
// This module only narrates it and takes it down.
//
// It comes down when BOTH are true:
//   1. React has mounted and painted, and
//   2. the boot coordinator reported a terminal stage (`ready` or `failed`).
//
// Waiting for (2) is what keeps the "backend is up before the first render" invariant
// the rest of the app leans on. The two overlap in wall-clock — the bundle parses
// while opencode boots — so this is barely slower than dismissing on (1) alone.

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

const SPLASH_ID = "boot-splash"
const STAGE_ID = "boot-splash-stage"
const FADE_MS = 220

/** Cap on the wait for React's first paint — see `whenPainted`. */
const PAINT_WAIT_MS = 2_000

type BootStage = "preparing" | "skills" | "engine" | "ready" | "failed"

const TERMINAL: readonly string[] = ["ready", "failed"]

/**
 * Honest stage names, not a fake percentage — the slow launch is the first one.
 *
 * Localised because the splash is up during the *longest* stretch of a first launch,
 * and the app defaults to English for any non-`zh` locale (`config.ts`
 * `detectDefaultLanguage`). The i18n bundle lives inside React, which by definition has
 * not mounted yet, so this reads the same persisted config the inline script in
 * index.html does.
 */
const STAGE_TEXT: Record<"zh" | "en", Record<BootStage, string>> = {
  zh: {
    preparing: "正在准备组件…",
    skills: "正在安装内置技能…",
    engine: "正在启动引擎…",
    ready: "就绪",
    failed: "启动引擎失败，应用可能无法正常工作",
  },
  en: {
    preparing: "Preparing components…",
    skills: "Installing built-in skills…",
    engine: "Starting the engine…",
    ready: "Ready",
    failed: "The engine failed to start; the app may not work correctly",
  },
}

function splashLanguage(): "zh" | "en" {
  try {
    const raw = localStorage.getItem("ultrawork-config")
    const stored = raw ? (JSON.parse(raw) as { language?: string }).language : undefined
    if (stored === "zh" || stored === "en") return stored
  } catch {
    // unreadable config — fall through to the locale
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en"
}

const STAGES = STAGE_TEXT[splashLanguage()]

/**
 * A boot that never reports a terminal stage would strand the user behind the splash
 * forever. The coordinator always reports one — every exit path signals, including a
 * panic — so this should never fire at all.
 *
 * It must stay **above** the host's own `BOOT_PORTS_WAIT` (90s), which is what
 * `loadSidecarPorts()` parks on. Fire first and we would pull the splash off a `#root`
 * that React has not rendered into yet, because the startup gate is still parked —
 * turning the backstop into a way to *reproduce* the white screen this all exists to
 * remove. Last line of defence, not a competitor to the gate.
 */
const BACKSTOP_MS = 120_000

function isTerminal(stage: unknown): stage is BootStage {
  return typeof stage === "string" && TERMINAL.includes(stage)
}

function isKnownStage(stage: unknown): stage is BootStage {
  return typeof stage === "string" && stage in STAGES
}

function setStageText(stage: BootStage): void {
  const el = document.getElementById(STAGE_ID)
  if (el) el.textContent = STAGES[stage]
}

/**
 * Resolve once the boot coordinator reaches a terminal stage.
 *
 * Two things this must survive:
 *
 * - **A missed event.** `boot-progress` can fire before we attach the listener —
 *   opencode reusing an already-healthy port reaches `ready` in milliseconds, while
 *   parsing this bundle takes hundreds. So after listening we also *ask* for the
 *   current stage. Listener first, then query: the reverse order has a hole between
 *   the two calls.
 * - **No real Tauri host.** Under vitest, and under the e2e runs (whose shim answers
 *   `null` to any command it does not implement), nothing will ever report a stage.
 *   So anything that is not a stage we recognise means "no host to wait for" and we
 *   resolve at once. Waiting on the event alone would leave a full-screen overlay
 *   swallowing every click in those runs until the backstop fired a minute later.
 */
function whenBootReady(): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }

    setTimeout(finish, BACKSTOP_MS)

    listen<{ stage?: string }>("boot-progress", (event) => {
      const stage = event.payload?.stage
      if (!isKnownStage(stage)) return
      setStageText(stage)
      if (isTerminal(stage)) finish()
    })
      .then(() =>
        invoke<unknown>("get_boot_status").then((stage) => {
          if (!isKnownStage(stage)) return finish() // no host behind this command
          setStageText(stage)
          if (isTerminal(stage)) finish()
        })
      )
      .catch(() => finish()) // not running under Tauri at all
  })
}

let tracking: Promise<void> | null = null

/**
 * Start listening for boot progress. Call this at the *top* of `main.tsx`, before the
 * startup gate — not after it.
 *
 * The ordering is load-bearing, and getting it wrong is silent: the gate
 * (`loadSidecarPorts()`) only resolves once the coordinator has finished booting the
 * engine, so a listener attached after it can never observe `preparing` / `skills` /
 * `engine` — they have all already fired. The splash would sit on its hardcoded
 * "正在启动…" for the whole boot, and the stage texts below would be dead code. That
 * matters most on exactly the launch where it matters most: the first one after an
 * install, which spends seconds copying sidecars and unpacking skills.
 */
export function beginBootTracking(): Promise<void> {
  tracking ??= whenBootReady()
  return tracking
}

/**
 * Two frames: one to commit React's first paint, one to be sure it was presented.
 *
 * Racing a timer is not belt-and-braces, it is the actual guard. Every webview we ship
 * on stops firing `requestAnimationFrame` while its window is minimised, hidden or
 * fully occluded — so this, not the event wait, is the leg that can hang forever
 * (minimise during boot, and the two frames never arrive). The backstop inside
 * `whenBootReady` cannot help: it only settles its own promise.
 */
function whenPainted(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, PAINT_WAIT_MS)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/** Fade out, then detach. */
function removeSplash(): void {
  const el = document.getElementById(SPLASH_ID)
  if (!el) return
  el.style.opacity = "0"
  setTimeout(() => el.remove(), FADE_MS)
}

/** Stop intercepting input, without hiding anything yet. */
function releaseSplashInput(): void {
  const el = document.getElementById(SPLASH_ID)
  if (el) el.style.pointerEvents = "none"
}

/**
 * Take the splash down as soon as the app is genuinely usable. Idempotent.
 * Call after `createRoot().render()`.
 */
export function dismissSplashWhenReady(): void {
  // Decoupled from the boot wait on purpose. The splash is a full-screen z-index 9999
  // overlay, so for as long as it accepts pointer events it swallows every click on the
  // app behind it. Once React has painted, the app is there to be clicked — whether or
  // not the engine has finished — so give input back immediately rather than tying it
  // to a wait that (in the pathological case) runs for another minute.
  void whenPainted().then(releaseSplashInput)

  void Promise.all([beginBootTracking(), whenPainted()]).then(removeSplash)
}
