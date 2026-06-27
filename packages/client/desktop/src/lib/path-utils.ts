/**
 * Cross-platform path helpers for the renderer.
 *
 * The desktop renderer runs in a WebView and has NO access to `node:path`.
 * Paths arrive from the backend (opencode / sidecars) and reflect the OS the
 * app runs on — POSIX (`/`) on macOS/Linux, Windows (`\`, sometimes mixed `/`)
 * on Windows. So every helper here must tolerate BOTH separators.
 */

/** Matches either path separator. */
const SEP_RE = /[\\/]/

/**
 * True if the path is absolute on any platform: POSIX (`/foo`) or
 * Windows drive-letter (`C:\foo`, `C:/foo`) / UNC (`\\server\share`).
 */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p)
}

/** Detect the dominant separator in a path (prefer "\" only when no "/" present). */
function detectSep(p: string): "/" | "\\" {
  return p.includes("/") || !p.includes("\\") ? "/" : "\\"
}

/**
 * Shorten a filesystem path for display.
 *
 * Rules:
 * 1. Replace the user's HOME directory with ~
 * 2. If total segment count ≤ maxSegments, return as-is
 * 3. Otherwise keep the first segment + "..." + last `tailCount` segments
 *
 * @param fullPath  Absolute path, e.g. "/Users/alice/projects/org/repo" or "C:\\Users\\alice\\repo"
 * @param options.maxSegments  Threshold below which no folding happens (default 4)
 * @param options.tailCount    Number of trailing segments to keep (default 1)
 * @param options.homedir      Override for the home directory (default: derived from path)
 */
export function shortenPath(
  fullPath: string,
  options: { maxSegments?: number; tailCount?: number; homedir?: string } = {},
): string {
  if (!fullPath) return fullPath

  const { maxSegments = 4, tailCount = 1 } = options
  const sep = detectSep(fullPath)

  // Detect home directory: prefer explicit override, else try common
  // macOS/Linux (/Users/x, /home/x) and Windows (C:\Users\x) patterns.
  const homedir =
    options.homedir ??
    (fullPath.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)/)?.[1] ||
      undefined)

  let display = fullPath
  if (homedir && display.startsWith(homedir)) {
    display = "~" + display.slice(homedir.length)
  }

  const segments = display.split(SEP_RE).filter(Boolean)

  if (segments.length <= maxSegments) return display

  // When the first segment is "~", keep 2 head segments so the result reads
  // "~/ai-workspace/..." instead of "~/..." — "~" is a pseudo-segment that
  // replaced "/Users/name" (two real directories), so it deserves an extra slot.
  const headCount = segments[0] === "~" ? 2 : 1
  const head = segments.slice(0, headCount)
  const tail = segments.slice(-tailCount)
  const isAbs = !display.startsWith("~") && (display.startsWith("/") || /^[A-Za-z]:[\\/]/.test(display))
  const prefix = isAbs && display.startsWith("/") ? "/" : ""

  return `${prefix}${head.join(sep)}${sep}...${sep}${tail.join(sep)}`
}

/**
 * Extract the last segment of a path (the project/folder/file name).
 * Tolerates trailing separators and both `/` and `\`.
 */
export function pathBasename(fullPath: string): string {
  if (!fullPath) return fullPath
  // Strip any trailing separators.
  const trimmed = fullPath.replace(/[\\/]+$/, "")
  const segments = trimmed.split(SEP_RE)
  return segments[segments.length - 1] || trimmed
}
