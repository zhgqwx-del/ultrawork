/**
 * Shorten a filesystem path for display.
 *
 * Rules:
 * 1. Replace the user's HOME directory with ~
 * 2. If total segment count ≤ maxSegments, return as-is
 * 3. Otherwise keep the first segment + "..." + last `tailCount` segments
 *
 * @param fullPath  Absolute path, e.g. "/Users/alice/projects/org/repo"
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

  // Detect home directory: prefer explicit override, else try common macOS/Linux pattern
  const homedir =
    options.homedir ??
    (fullPath.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/)?.[1] || undefined)

  let display = fullPath
  if (homedir && display.startsWith(homedir)) {
    display = "~" + display.slice(homedir.length)
  }

  const segments = display.split("/").filter(Boolean)

  if (segments.length <= maxSegments) return display

  // When the first segment is "~", keep 2 head segments so the result reads
  // "~/ai-workspace/..." instead of "~/..." — "~" is a pseudo-segment that
  // replaced "/Users/name" (two real directories), so it deserves an extra slot.
  const headCount = segments[0] === "~" ? 2 : 1
  const head = segments.slice(0, headCount)
  const tail = segments.slice(-tailCount)
  const prefix = display.startsWith("/") && !display.startsWith("~") ? "/" : ""

  return `${prefix}${head.join("/")}/.../${tail.join("/")}`
}

/**
 * Extract the last segment of a path (the project/folder name).
 */
export function pathBasename(fullPath: string): string {
  if (!fullPath) return fullPath
  const trimmed = fullPath.endsWith("/") ? fullPath.slice(0, -1) : fullPath
  const lastSlash = trimmed.lastIndexOf("/")
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1)
}
