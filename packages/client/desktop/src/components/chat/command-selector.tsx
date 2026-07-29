import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import { Globe, Sparkles, Terminal } from "lucide-react"
import {
  groupBySource,
  rankEntries,
  toMenuEntries,
  type CommandMenuEntry,
  type RankedEntry,
  type SkillSource,
} from "@/lib/command-menu"
import type { Command } from "@agent/api-client"

/** Per-row source marker. With one group today (see below) this is the only
 *  thing that actually tells types apart, so it is not optional chrome. */
const SOURCE_ICONS: Record<SkillSource, typeof Terminal> = {
  command: Terminal,
  mcp: Globe,
  skill: Sparkles,
}

interface CommandSelectorProps {
  input: string
  onSelectCommand: (command: CommandMenuEntry) => void
  /** Dismiss without touching the user's text — the caller owns that decision. */
  onClose: () => void
  visible: boolean
  /**
   * The composer's IME composition state. While an input method is composing,
   * Enter commits the candidate and the arrows walk the candidate list — none of
   * those keys belong to this menu. The composer already tracks this (including
   * the compositionEnd-fires-before-keyDown workaround), so it is passed down
   * rather than tracked a second time here.
   */
  composing?: boolean
}

export function CommandSelector({ input, onSelectCommand, onClose, visible, composing = false }: CommandSelectorProps) {
  const api = useApi()
  const { t } = useI18n()
  const [commands, setCommands] = useState<Command[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [hasFetched, setHasFetched] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch once, and only after the menu is first asked for — this list must not
  // be on the startup path.
  useEffect(() => {
    if (!visible || hasFetched) return
    api.getCommands().then((cmds) => {
      setCommands(cmds)
      setHasFetched(true)
    }).catch((err) => {
      console.error("Failed to fetch commands:", err)
    })
  }, [visible, hasFetched, api])

  const query = input.startsWith("/") ? input.slice(1) : ""
  const entries = useMemo(() => toMenuEntries(commands), [commands])

  // Empty query → grouped by source; any query → one flat list in match-rank
  // order, so entries[0] is always the best match and Enter can't pick a weak
  // description hit over a perfect name prefix (discussions/056 §8.1).
  const grouped = useMemo(() => (query ? [] : groupBySource(entries)), [entries, query])
  const ordered = useMemo<CommandMenuEntry[]>(
    () => (query ? entries : grouped.flatMap((g) => g.items)),
    [entries, grouped, query]
  )
  const { entries: ranked, descriptionMatchStart } = useMemo(
    () => rankEntries(ordered, query),
    [ordered, query]
  )

  // Group headers only earn their space once there is something to tell apart.
  // A default install has exactly one non-empty group (`init`/`review` are
  // hidden, no config commands ship, and the bundled MCP servers expose tools
  // but no prompts), so a lone "Skills" header would be pure noise.
  const showGroupHeaders = !query && grouped.length >= 2
  const headerIndexes = useMemo(() => {
    if (!showGroupHeaders) return new Map<number, SkillSource>()
    const map = new Map<number, SkillSource>()
    let index = 0
    for (const group of grouped) {
      map.set(index, group.key)
      index += group.items.length
    }
    return map
  }, [grouped, showGroupHeaders])

  /**
   * The panel is labelled only when everything in it comes from one source, and
   * then it is labelled with THAT source. Naming is single-mechanism on purpose:
   * a fixed "Commands" header used to sit above a list that is, on a default
   * install, 100% skills — while the settings page and the group headers below
   * both call the same things "Skills". Heterogeneous content is named by the
   * group headers (empty query) or by nothing at all (a ranked, mixed result).
   */
  const soleSource = useMemo<SkillSource | null>(() => {
    const sources = new Set(ranked.map((e) => e.source))
    return sources.size === 1 ? [...sources][0] : null
  }, [ranked])

  const safeIndex = ranked.length ? Math.min(selectedIndex, ranked.length - 1) : 0

  // "On screen and owning the keyboard". Kept distinct from `visible`: while the
  // fetch is in flight nothing is painted, so swallowing Escape here would steal
  // it from whatever else is listening for it.
  const open = visible && hasFetched

  // Reset on `open` as well as on `query`: for the bare "/" the query is the
  // empty string, which is also the query while the menu is closed — so keying
  // the reset on the query alone leaves a reopened menu still sitting on
  // whatever row the arrows last reached, now scrolled away from the top.
  useEffect(() => {
    setSelectedIndex(0)
  }, [query, open])

  // Keep the active row on screen. Without this the list scrolls (max-h below)
  // but arrow-key navigation walks straight out of view.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${safeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [open, safeIndex])

  /**
   * Runs on `document` in the CAPTURE phase, so consuming a key here means
   * calling `stopPropagation` — that is what keeps the composer from also
   * acting on it. The alternative (mirroring "do I have candidates?" up to the
   * composer as state) is a render behind by construction: it travels
   * render → effect → setState, so a handler reading it mid-event can see the
   * stale value, and Enter then either double-fires or gets swallowed. This
   * component is the one that knows, synchronously — so it decides here.
   *
   * Keys it does NOT consume fall through untouched, which is exactly how a
   * `/word` matching nothing still gets sent (discussions/056 §2.1).
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return
      // An input method owns the keyboard while it is composing: Enter commits
      // the candidate, the arrows walk the candidate list. Consuming those here
      // would replace the user's half-typed Chinese with a command. `keyCode
      // 229` is the legacy signal some IMEs still send instead of isComposing.
      if (composing || e.isComposing || e.keyCode === 229) return
      const consume = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (e.key === "Escape") {
        consume()
        onClose()
        return
      }
      if (ranked.length === 0) return
      if (e.key === "ArrowDown") {
        consume()
        setSelectedIndex((i) => (Math.min(i, ranked.length - 1) + 1) % ranked.length)
      } else if (e.key === "ArrowUp") {
        consume()
        setSelectedIndex((i) => (Math.min(i, ranked.length - 1) - 1 + ranked.length) % ranked.length)
      } else if (e.key === "Tab" || e.key === "Enter") {
        consume()
        onSelectCommand(ranked[safeIndex])
      }
    },
    [open, composing, ranked, safeIndex, onSelectCommand, onClose]
  )

  useEffect(() => {
    if (!open) return
    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [open, handleKeyDown])

  // Nothing until the list is actually in hand: an empty `commands` is
  // indistinguishable from "no match", so rendering early flashes the empty
  // state on every first open. A failed fetch keeps the menu closed, which is
  // the honest outcome — there are no commands to offer.
  if (!open) return null

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-full max-w-md overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg">
      {soleSource && (
        <p className="px-3 pb-1 pt-2 text-[10px] font-medium text-[var(--color-fg-muted)]">
          {t(`command.group.${soleSource}`)}
        </p>
      )}
      {/* max-h + scroll: the list is unbounded otherwise, and grows upward past
          the top of the layout card (which is overflow-hidden), leaving rows
          rendered but unreachable — discussions/056 §2. */}
      {/* pt-0 only when a title already supplies the top padding. */}
      <div ref={listRef} className={cn("scrollbar-soft max-h-64 overflow-y-auto p-1.5", soleSource && "pt-0")}>
        {ranked.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-[var(--color-fg-muted)]">
            {t("command.noMatch")}
          </p>
        ) : (
          ranked.map((cmd, i) => (
            <CommandRow
              key={cmd.name}
              cmd={cmd}
              index={i}
              selected={i === safeIndex}
              groupLabel={headerIndexes.has(i) ? t(`command.group.${headerIndexes.get(i)!}`) : undefined}
              dividerLabel={i === descriptionMatchStart ? t("command.descriptionMatch") : undefined}
              onSelect={onSelectCommand}
              onHover={setSelectedIndex}
            />
          ))
        )}
      </div>
    </div>
  )
}

function CommandRow({
  cmd,
  index,
  selected,
  groupLabel,
  dividerLabel,
  onSelect,
  onHover,
}: {
  cmd: RankedEntry
  index: number
  selected: boolean
  groupLabel?: string
  dividerLabel?: string
  onSelect: (cmd: CommandMenuEntry) => void
  onHover: (index: number) => void
}) {
  const Icon = SOURCE_ICONS[cmd.source] ?? Terminal
  return (
    <>
      {groupLabel && (
        <p className="px-2 pb-1 pt-2 text-[10px] font-medium text-[var(--color-fg-muted)]">{groupLabel}</p>
      )}
      {dividerLabel && (
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="h-px flex-1 bg-[var(--color-border)]" />
          <span className="text-[10px] text-[var(--color-fg-muted)]">{dividerLabel}</span>
          <span className="h-px flex-1 bg-[var(--color-border)]" />
        </div>
      )}
      <button
        type="button"
        data-index={index}
        // Hovering moves the selection rather than painting a second highlight:
        // one highlighted row at a time, so "which one does Enter take?" has an
        // answer at all times.
        onMouseEnter={() => onHover(index)}
        onClick={() => onSelect(cmd)}
        // The description is truncated to one line; the full text (written for
        // the model, routinely 300–600 chars) stays reachable here.
        title={cmd.description || undefined}
        className={cn(
          "flex min-h-[2.75rem] w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
          selected && "bg-[var(--color-accent)]"
        )}
      >
        <Icon className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-[var(--color-fg)]">/{cmd.name}</div>
          {cmd.description && (
            // No opacity here: muted × opacity-70 lands at 2.68:1 (light) and
            // 3.73:1 (dark), both under WCAG AA 4.5:1 for text this size.
            // The selected row needs its own colour too — muted on the accent
            // background is 4.40:1, which still misses. Hierarchy against the
            // name then comes from size and weight, which costs no contrast.
            // Gated by command-menu-contrast.test.ts.
            <div
              className={cn(
                "truncate text-[11px]",
                selected ? "text-[var(--color-accent-fg)]" : "text-[var(--color-fg-muted)]"
              )}
            >
              {cmd.description}
            </div>
          )}
        </div>
      </button>
    </>
  )
}
