import { cn } from "@/lib/utils"

/**
 * File type icon component — renders a colored file icon with extension badge.
 * Uses a file-shape base with a colored extension label overlay for high visual distinction.
 */

interface FileIconProps {
  filename: string
  mime?: string
  className?: string
  size?: number
}

// Extension → { label (shown on badge), bg color, text color }
interface IconStyle {
  label: string
  bg: string    // Tailwind bg class
  fg: string    // Tailwind text class for the label
  accent: string // Tailwind text class for the file shape stroke
}

const EXT_STYLES: Record<string, IconStyle> = {
  // Web
  html: { label: "HTML", bg: "bg-orange-500", fg: "text-white", accent: "text-orange-500" },
  htm: { label: "HTM", bg: "bg-orange-500", fg: "text-white", accent: "text-orange-500" },
  css: { label: "CSS", bg: "bg-blue-500", fg: "text-white", accent: "text-blue-500" },
  scss: { label: "SCSS", bg: "bg-pink-500", fg: "text-white", accent: "text-pink-500" },
  less: { label: "LESS", bg: "bg-blue-400", fg: "text-white", accent: "text-blue-400" },
  // JavaScript / TypeScript
  js: { label: "JS", bg: "bg-yellow-400", fg: "text-yellow-900", accent: "text-yellow-500" },
  jsx: { label: "JSX", bg: "bg-cyan-500", fg: "text-white", accent: "text-cyan-500" },
  mjs: { label: "MJS", bg: "bg-yellow-400", fg: "text-yellow-900", accent: "text-yellow-500" },
  cjs: { label: "CJS", bg: "bg-yellow-400", fg: "text-yellow-900", accent: "text-yellow-500" },
  ts: { label: "TS", bg: "bg-blue-600", fg: "text-white", accent: "text-blue-600" },
  tsx: { label: "TSX", bg: "bg-blue-500", fg: "text-white", accent: "text-blue-500" },
  // Data
  json: { label: "JSON", bg: "bg-yellow-600", fg: "text-white", accent: "text-yellow-600" },
  jsonc: { label: "JSON", bg: "bg-yellow-600", fg: "text-white", accent: "text-yellow-600" },
  yaml: { label: "YML", bg: "bg-red-400", fg: "text-white", accent: "text-red-400" },
  yml: { label: "YML", bg: "bg-red-400", fg: "text-white", accent: "text-red-400" },
  toml: { label: "TOML", bg: "bg-gray-500", fg: "text-white", accent: "text-gray-500" },
  xml: { label: "XML", bg: "bg-orange-400", fg: "text-white", accent: "text-orange-400" },
  csv: { label: "CSV", bg: "bg-green-600", fg: "text-white", accent: "text-green-600" },
  sql: { label: "SQL", bg: "bg-blue-400", fg: "text-white", accent: "text-blue-400" },
  // Languages
  py: { label: "PY", bg: "bg-blue-500", fg: "text-yellow-300", accent: "text-blue-500" },
  go: { label: "GO", bg: "bg-cyan-600", fg: "text-white", accent: "text-cyan-600" },
  rs: { label: "RS", bg: "bg-orange-600", fg: "text-white", accent: "text-orange-600" },
  java: { label: "JAVA", bg: "bg-red-500", fg: "text-white", accent: "text-red-500" },
  kt: { label: "KT", bg: "bg-purple-500", fg: "text-white", accent: "text-purple-500" },
  c: { label: "C", bg: "bg-blue-500", fg: "text-white", accent: "text-blue-500" },
  cpp: { label: "C++", bg: "bg-blue-600", fg: "text-white", accent: "text-blue-600" },
  h: { label: "H", bg: "bg-blue-400", fg: "text-white", accent: "text-blue-400" },
  hpp: { label: "H++", bg: "bg-blue-500", fg: "text-white", accent: "text-blue-500" },
  rb: { label: "RB", bg: "bg-red-600", fg: "text-white", accent: "text-red-600" },
  php: { label: "PHP", bg: "bg-indigo-500", fg: "text-white", accent: "text-indigo-500" },
  swift: { label: "SW", bg: "bg-orange-500", fg: "text-white", accent: "text-orange-500" },
  // Shell
  sh: { label: "SH", bg: "bg-green-600", fg: "text-white", accent: "text-green-600" },
  bash: { label: "SH", bg: "bg-green-600", fg: "text-white", accent: "text-green-600" },
  zsh: { label: "ZSH", bg: "bg-green-600", fg: "text-white", accent: "text-green-600" },
  // Documents
  md: { label: "MD", bg: "bg-blue-400", fg: "text-white", accent: "text-blue-400" },
  mdx: { label: "MDX", bg: "bg-blue-400", fg: "text-white", accent: "text-blue-400" },
  txt: { label: "TXT", bg: "bg-gray-400", fg: "text-white", accent: "text-gray-400" },
  pdf: { label: "PDF", bg: "bg-red-500", fg: "text-white", accent: "text-red-500" },
  // Office
  doc: { label: "DOC", bg: "bg-blue-600", fg: "text-white", accent: "text-blue-600" },
  docx: { label: "DOC", bg: "bg-blue-600", fg: "text-white", accent: "text-blue-600" },
  xls: { label: "XLS", bg: "bg-green-600", fg: "text-white", accent: "text-green-600" },
  xlsx: { label: "XLS", bg: "bg-green-600", fg: "text-white", accent: "text-green-600" },
  ppt: { label: "PPT", bg: "bg-orange-600", fg: "text-white", accent: "text-orange-600" },
  pptx: { label: "PPT", bg: "bg-orange-600", fg: "text-white", accent: "text-orange-600" },
  // Images
  png: { label: "PNG", bg: "bg-purple-500", fg: "text-white", accent: "text-purple-500" },
  jpg: { label: "JPG", bg: "bg-purple-500", fg: "text-white", accent: "text-purple-500" },
  jpeg: { label: "JPG", bg: "bg-purple-500", fg: "text-white", accent: "text-purple-500" },
  gif: { label: "GIF", bg: "bg-purple-400", fg: "text-white", accent: "text-purple-400" },
  svg: { label: "SVG", bg: "bg-yellow-500", fg: "text-yellow-900", accent: "text-yellow-500" },
  webp: { label: "WEBP", bg: "bg-purple-500", fg: "text-white", accent: "text-purple-500" },
  ico: { label: "ICO", bg: "bg-purple-400", fg: "text-white", accent: "text-purple-400" },
  avif: { label: "AVIF", bg: "bg-purple-500", fg: "text-white", accent: "text-purple-500" },
  bmp: { label: "BMP", bg: "bg-purple-400", fg: "text-white", accent: "text-purple-400" },
  // Config
  env: { label: "ENV", bg: "bg-yellow-600", fg: "text-white", accent: "text-yellow-600" },
  gitignore: { label: "GIT", bg: "bg-gray-500", fg: "text-white", accent: "text-gray-500" },
  // Archives
  zip: { label: "ZIP", bg: "bg-yellow-600", fg: "text-white", accent: "text-yellow-600" },
  tar: { label: "TAR", bg: "bg-yellow-600", fg: "text-white", accent: "text-yellow-600" },
  gz: { label: "GZ", bg: "bg-yellow-600", fg: "text-white", accent: "text-yellow-600" },
  rar: { label: "RAR", bg: "bg-yellow-600", fg: "text-white", accent: "text-yellow-600" },
  "7z": { label: "7Z", bg: "bg-yellow-600", fg: "text-white", accent: "text-yellow-600" },
  // Video / Audio
  mp4: { label: "MP4", bg: "bg-pink-500", fg: "text-white", accent: "text-pink-500" },
  mov: { label: "MOV", bg: "bg-pink-500", fg: "text-white", accent: "text-pink-500" },
  avi: { label: "AVI", bg: "bg-pink-500", fg: "text-white", accent: "text-pink-500" },
  mp3: { label: "MP3", bg: "bg-pink-400", fg: "text-white", accent: "text-pink-400" },
  wav: { label: "WAV", bg: "bg-pink-400", fg: "text-white", accent: "text-pink-400" },
  // Misc
  skill: { label: "SKILL", bg: "bg-violet-500", fg: "text-white", accent: "text-violet-500" },
  log: { label: "LOG", bg: "bg-gray-400", fg: "text-white", accent: "text-gray-400" },
}

const DEFAULT_STYLE: IconStyle = {
  label: "",
  bg: "bg-gray-400",
  fg: "text-white",
  accent: "text-[var(--color-fg-muted)]",
}

function getExtension(filename: string): string {
  const name = filename.split("/").pop() || filename
  if (name.startsWith(".") && !name.includes(".", 1)) {
    return name.slice(1)
  }
  return name.split(".").pop()?.toLowerCase() || ""
}

function getStyle(filename: string, mime?: string): IconStyle {
  if (mime) {
    if (mime.startsWith("image/")) return EXT_STYLES.png || DEFAULT_STYLE
    if (mime.startsWith("video/")) return EXT_STYLES.mp4 || DEFAULT_STYLE
    if (mime.startsWith("audio/")) return EXT_STYLES.mp3 || DEFAULT_STYLE
    if (mime.includes("pdf")) return EXT_STYLES.pdf || DEFAULT_STYLE
  }
  const ext = getExtension(filename)
  return EXT_STYLES[ext] || { ...DEFAULT_STYLE, label: ext.toUpperCase().slice(0, 4) }
}

export function FileIcon({ filename, mime, className, size = 14 }: FileIconProps) {
  const style = getStyle(filename, mime)
  const s = size
  // Scale proportionally: badge area is bottom portion of the icon
  const badgeH = s * 0.4
  const badgeR = s * 0.1
  const fontSize = style.label.length > 3 ? s * 0.19 : s * 0.24

  return (
    <div className={cn("relative shrink-0", className)} style={{ width: s, height: s }}>
      {/* File shape base */}
      <svg
        width={s}
        height={s}
        viewBox={`0 0 ${s} ${s}`}
        fill="none"
        className={style.accent}
      >
        {/* File body */}
        <path
          d={`M${s * 0.15} ${s * 0.06} H${s * 0.62} L${s * 0.88} ${s * 0.25} V${s * 0.94} H${s * 0.15} Z`}
          fill="currentColor"
          fillOpacity={0.1}
          stroke="currentColor"
          strokeOpacity={0.5}
          strokeWidth={s * 0.06}
          strokeLinejoin="round"
        />
        {/* Folded corner */}
        <path
          d={`M${s * 0.62} ${s * 0.06} V${s * 0.25} H${s * 0.88}`}
          fill="currentColor"
          fillOpacity={0.15}
          stroke="currentColor"
          strokeOpacity={0.5}
          strokeWidth={s * 0.06}
          strokeLinejoin="round"
        />
      </svg>
      {/* Extension badge */}
      {style.label && (
        <div
          className={cn(
            "absolute flex items-center justify-center font-bold leading-none",
            style.bg, style.fg
          )}
          style={{
            bottom: 0,
            left: 0,
            right: 0,
            height: badgeH,
            fontSize,
            borderRadius: badgeR,
            letterSpacing: "-0.02em",
          }}
        >
          {style.label}
        </div>
      )}
    </div>
  )
}

/** Check if a file extension indicates a binary/non-previewable file */
export function isBinaryFile(filename: string): boolean {
  const ext = getExtension(filename)
  return BINARY_EXTS.has(ext)
}

const BINARY_EXTS = new Set([
  "ppt", "pptx", "doc", "docx", "xls", "xlsx",
  "zip", "tar", "gz", "rar", "7z",
  "mp4", "mov", "avi", "mkv", "wmv",
  "mp3", "wav", "flac", "aac", "ogg",
  "exe", "dmg", "pkg", "deb", "rpm",
  "ttf", "otf", "woff", "woff2",
])

/** Get a human-readable file type description */
export function getFileTypeLabel(filename: string): string {
  const ext = getExtension(filename).toUpperCase()
  const labels: Record<string, string> = {
    PPTX: "PowerPoint",
    PPT: "PowerPoint",
    DOCX: "Word",
    DOC: "Word",
    XLSX: "Excel",
    XLS: "Excel",
    ZIP: "ZIP Archive",
    TAR: "TAR Archive",
    GZ: "GZip Archive",
    RAR: "RAR Archive",
    MP4: "Video",
    MOV: "Video",
    AVI: "Video",
    MP3: "Audio",
    WAV: "Audio",
    PDF: "PDF",
    DMG: "Disk Image",
  }
  return labels[ext] || `${ext} File`
}
