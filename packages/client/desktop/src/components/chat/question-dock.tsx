import { useState } from "react"
import { HelpCircle } from "lucide-react"
import { useI18n } from "@/lib/i18n-context"
import type { QuestionRequest } from "@agent/api-client"

interface QuestionDockProps {
  request: QuestionRequest
  onReply: (answers: string[][]) => void
  onReject: () => void
}

export function QuestionDock({ request, onReply, onReject }: QuestionDockProps) {
  const { t } = useI18n()
  const questions = request.questions
  const [currentIndex, setCurrentIndex] = useState(0)
  // answers[i] = selected labels for question i
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []))
  const [customInputs, setCustomInputs] = useState<string[]>(() => questions.map(() => ""))

  const q = questions[currentIndex]
  if (!q) return null

  const isMultiple = q.multiple === true
  const showCustom = q.custom !== false
  const isLast = currentIndex === questions.length - 1

  const toggleOption = (label: string) => {
    setAnswers((prev) => {
      const next = [...prev]
      const current = next[currentIndex]
      if (isMultiple) {
        next[currentIndex] = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
      } else {
        next[currentIndex] = current.includes(label) ? [] : [label]
      }
      return next
    })
  }

  const handleNext = () => {
    if (isLast) {
      // Merge custom input as an extra selection if non-empty
      const finalAnswers = answers.map((ans, i) => {
        const custom = customInputs[i]?.trim()
        return custom ? [...ans, custom] : ans
      })
      onReply(finalAnswers)
    } else {
      setCurrentIndex((i) => i + 1)
    }
  }

  const handleBack = () => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1)
  }

  const hasSelection = answers[currentIndex].length > 0 || customInputs[currentIndex].trim().length > 0

  return (
    <div className="mx-auto w-full max-w-[800px] px-4 py-3">
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
        {/* Header */}
        <div className="mb-3 flex items-center gap-2">
          <HelpCircle className="size-5 text-blue-500" />
          <span className="text-sm font-medium text-[--color-fg]">
            {q.header || t("question.title")}
          </span>
          {questions.length > 1 && (
            <span className="ml-auto text-xs text-[--color-fg-muted]">
              {currentIndex + 1} / {questions.length}
            </span>
          )}
        </div>

        {/* Question text */}
        <p className="mb-3 text-sm text-[--color-fg]">{q.question}</p>

        {/* Options */}
        <div className="mb-3 space-y-1.5">
          {q.options.map((opt) => {
            const selected = answers[currentIndex].includes(opt.label)
            return (
              <button
                key={opt.label}
                onClick={() => toggleOption(opt.label)}
                className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? "border-blue-500 bg-blue-500/10 text-[--color-fg]"
                    : "border-[--color-border] text-[--color-fg-muted] hover:border-blue-500/50 hover:bg-blue-500/5"
                }`}
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-current">
                  {selected && <span className="size-2 rounded-full bg-blue-500" />}
                </span>
                <span>
                  <span className="font-medium text-[--color-fg]">{opt.label}</span>
                  {opt.description && (
                    <span className="ml-1 text-[--color-fg-muted]">— {opt.description}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>

        {/* Custom input */}
        {showCustom && (
          <input
            type="text"
            value={customInputs[currentIndex]}
            onChange={(e) =>
              setCustomInputs((prev) => {
                const next = [...prev]
                next[currentIndex] = e.target.value
                return next
              })
            }
            placeholder={t("question.customInput")}
            className="mb-3 w-full rounded-lg border border-[--color-border] bg-[--color-bg] px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:border-blue-500 focus:outline-none"
          />
        )}

        {/* Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={onReject}
            className="rounded-lg border border-[--color-border] px-4 py-1.5 text-sm text-[--color-fg-muted] transition-colors hover:bg-[--color-bg-secondary]"
          >
            {t("question.dismiss")}
          </button>
          <div className="flex-1" />
          {currentIndex > 0 && (
            <button
              onClick={handleBack}
              className="rounded-lg border border-[--color-border] px-4 py-1.5 text-sm text-[--color-fg-muted] transition-colors hover:bg-[--color-bg-secondary]"
            >
              {t("question.back")}
            </button>
          )}
          <button
            onClick={handleNext}
            disabled={!hasSelection}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
          >
            {isLast ? t("question.submit") : t("question.next")}
          </button>
        </div>
      </div>
    </div>
  )
}
