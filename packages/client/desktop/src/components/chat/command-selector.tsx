import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { Terminal } from "lucide-react"
import type { Command } from "@agent/api-client"

interface CommandSelectorProps {
  input: string
  onSelectCommand: (command: Command) => void
  onClose: () => void
  visible: boolean
}

export function CommandSelector({ input, onSelectCommand, onClose, visible }: CommandSelectorProps) {
  const api = useApi()
  const { t } = useI18n()
  const [commands, setCommands] = useState<Command[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [hasFetched, setHasFetched] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch commands once
  useEffect(() => {
    if (!visible || hasFetched) return
    api.getCommands().then((cmds) => {
      setCommands(cmds)
      setHasFetched(true)
    }).catch((err) => {
      console.error("Failed to fetch commands:", err)
    })
  }, [visible, hasFetched, api])

  // Filter commands based on input after "/"
  const query = input.startsWith("/") ? input.slice(1).toLowerCase() : ""
  const filtered = useMemo(() => commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query)
  ), [commands, query])

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        return
      }
      if (filtered.length === 0) return
      const safeIndex = Math.min(selectedIndex, filtered.length - 1)
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % filtered.length)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length)
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault()
        onSelectCommand(filtered[safeIndex])
      }
    },
    [visible, filtered, selectedIndex, onSelectCommand, onClose]
  )

  useEffect(() => {
    if (!visible) return
    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [visible, handleKeyDown])

  if (!visible || filtered.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 z-50 mb-1 w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
    >
      <div className="p-1.5">
        <p className="px-2 pb-1 text-[10px] font-medium text-[var(--color-fg-muted)]">
          {t("command.title")}
        </p>
        {filtered.map((cmd, i) => (
          <button
            key={cmd.name}
            onClick={() => onSelectCommand(cmd)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
              i === selectedIndex
                ? "bg-[var(--color-accent)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
            }`}
          >
            <Terminal className="size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <span className="text-xs font-medium">/{cmd.name}</span>
              <span className="ml-2 text-[10px] opacity-70">{cmd.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
