import { openUrl } from "@tauri-apps/plugin-opener"

/**
 * Protocols we are willing to hand to the OS.
 *
 * `openUrl` shells out to the system handler (`open` / ShellExecute / xdg-open),
 * so a scheme outside this list is not "a link" — it is a way to launch an
 * arbitrary local app or file. That matters because the biggest caller is the
 * chat transcript, whose content is model output, and model output is only
 * semi-trusted: it can be steered by page content the agent fetched, or (via the
 * IM channels) by whatever a third party sent the bot.
 *
 * react-markdown's `defaultUrlTransform` already strips `javascript:`/`data:`/
 * `file:` before we ever see the href, but that is the renderer's guard, not
 * ours — anything that opens a URL without going through react-markdown (the
 * settings pages, future callers) would not be covered. Hence the whitelist here,
 * at the point where the URL actually reaches the OS.
 *
 * Corollary: do NOT hand react-markdown a permissive custom `urlTransform` to let
 * IM deeplinks through. That removes the renderer's layer and leaves only this one.
 */
const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"])

/**
 * Whether `href` is something we will open in the system browser.
 *
 * Relative paths (`./report.pdf`), bare anchors (`#section`) and malformed URLs
 * all throw in the `URL` constructor and land as `false` — deliberately, since
 * none of them mean anything to the system handler. Callers render those as
 * inert text rather than a dead link.
 */
export function isOpenableUrl(href: string | undefined | null): href is string {
  if (!href) return false
  try {
    return OPENABLE_PROTOCOLS.has(new URL(href).protocol)
  } catch {
    return false
  }
}

/**
 * Open `href` in the system browser. No-op for anything `isOpenableUrl` rejects.
 *
 * Never render a bare `<a href>` instead: in a Tauri WebView a plain anchor
 * navigates the webview in place (the whole app is replaced by the page, with no
 * way back), and `target="_blank"` is silently swallowed — the click does nothing
 * at all. See gotchas §"window.open 打不开系统浏览器".
 */
export function openExternal(href: string | undefined | null): void {
  if (!isOpenableUrl(href)) return
  void openUrl(href).catch((e) => console.error("[openExternal] failed:", href, e))
}
