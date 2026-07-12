import type { Components } from "react-markdown"
import { isOpenableUrl, openExternal } from "@/lib/external-url"

/**
 * The `a` renderer for every ReactMarkdown instance in the app.
 *
 * Shared rather than duplicated because the two call sites had drifted into two
 * different bugs: the transcript rendered `target="_blank"` (swallowed by the
 * WebView → the click did nothing), and the markdown artifact preview used the
 * default anchor (which navigates the webview in place, replacing the app).
 *
 * `href` is kept on the element so right-click → copy link address still works;
 * the click itself is intercepted and routed to the system browser.
 */
export const MarkdownLink: Components["a"] = ({ children, href }) => {
  // Relative links (`./report.pdf`) and anchors (`#section`) mean nothing to the
  // system browser, and the model emits them freely. Render them as inert text —
  // a link that visibly does nothing is worse than text that never promised to.
  if (!isOpenableUrl(href)) {
    return (
      <span className="break-words text-[var(--color-fg)]" title={href}>
        {children}
      </span>
    )
  }

  return (
    <a
      href={href}
      // The href is shown on hover so the destination of a model-supplied link is
      // inspectable before clicking — the link text is chosen by the model and
      // need not match where it goes.
      title={href}
      className="break-words text-[var(--color-primary)] underline hover:opacity-80"
      onClick={(e) => {
        e.preventDefault()
        openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/** For ReactMarkdown instances that only need the link fix (no other overrides). */
export const MARKDOWN_LINK_ONLY: Components = { a: MarkdownLink }
