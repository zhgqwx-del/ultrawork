import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QuestionDock } from "@/components/chat/question-dock"
import type { QuestionRequest } from "@agent/api-client"

// Mock i18n
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "question.title": "Question",
        "question.submit": "Submit",
        "question.dismiss": "Dismiss",
        "question.next": "Next",
        "question.back": "Back",
        "question.customInput": "Or type a custom answer...",
      }
      return map[key] || key
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

const singleQuestion: QuestionRequest = {
  id: "q1",
  sessionID: "s1",
  questions: [
    {
      question: "Which framework do you prefer?",
      header: "Framework",
      options: [
        { label: "React", description: "A JavaScript library" },
        { label: "Vue", description: "Progressive framework" },
        { label: "Angular", description: "Platform for web" },
      ],
    },
  ],
}

const multiQuestion: QuestionRequest = {
  id: "q2",
  sessionID: "s1",
  questions: [
    {
      question: "Choose a language",
      header: "Language",
      options: [
        { label: "TypeScript", description: "Typed JS" },
        { label: "Python", description: "General purpose" },
      ],
    },
    {
      question: "Choose a database",
      header: "Database",
      options: [
        { label: "PostgreSQL", description: "Relational" },
        { label: "MongoDB", description: "Document DB" },
      ],
    },
  ],
}

describe("QuestionDock", () => {
  it("renders question text", () => {
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    expect(
      screen.getByText("Which framework do you prefer?")
    ).toBeInTheDocument()
  })

  it("renders header (not generic title) when header is set", () => {
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    // Header is "Framework", not "Question"
    expect(screen.getByText("Framework")).toBeInTheDocument()
  })

  it("renders option labels", () => {
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    expect(screen.getByText("React")).toBeInTheDocument()
    expect(screen.getByText("Vue")).toBeInTheDocument()
    expect(screen.getByText("Angular")).toBeInTheDocument()
  })

  it("renders option descriptions with em dash prefix", () => {
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    // Description is rendered as "— description" inside a span
    expect(screen.getByText(/A JavaScript library/)).toBeInTheDocument()
  })

  it("calls onReject when Dismiss clicked", () => {
    const onReject = vi.fn()
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={vi.fn()}
        onReject={onReject}
      />
    )
    fireEvent.click(screen.getByText("Dismiss"))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it("selects an option on click and enables Submit", () => {
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    const reactBtn = screen.getByText("React").closest("button")!
    fireEvent.click(reactBtn)
    const submitBtn = screen.getByText("Submit")
    expect(submitBtn).not.toBeDisabled()
  })

  it("calls onReply with selected answers on Submit", () => {
    const onReply = vi.fn()
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )

    // Select "React"
    const reactBtn = screen.getByText("React").closest("button")!
    fireEvent.click(reactBtn)
    // Submit
    fireEvent.click(screen.getByText("Submit"))

    expect(onReply).toHaveBeenCalledWith([["React"]])
  })

  it("deselects on second click (single select)", () => {
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )

    const reactBtn = screen.getByText("React").closest("button")!
    // Select
    fireEvent.click(reactBtn)
    // Deselect
    fireEvent.click(reactBtn)

    const submitBtn = screen.getByText("Submit")
    expect(submitBtn).toBeDisabled()
  })

  it("navigates between questions with Next/Back", () => {
    render(
      <QuestionDock
        request={multiQuestion}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )

    // Should show first question
    expect(screen.getByText("Choose a language")).toBeInTheDocument()
    // Shows counter
    expect(screen.getByText("1 / 2")).toBeInTheDocument()

    // Select an option for first question
    const tsBtn = screen.getByText("TypeScript").closest("button")!
    fireEvent.click(tsBtn)

    // Click Next
    fireEvent.click(screen.getByText("Next"))

    // Should show second question
    expect(screen.getByText("Choose a database")).toBeInTheDocument()
    expect(screen.getByText("2 / 2")).toBeInTheDocument()

    // Click Back
    fireEvent.click(screen.getByText("Back"))

    // Should show first question again
    expect(screen.getByText("Choose a language")).toBeInTheDocument()
  })

  it("Submit button is disabled when no selection", () => {
    render(
      <QuestionDock
        request={singleQuestion}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    const submitBtn = screen.getByText("Submit")
    expect(submitBtn).toBeDisabled()
  })
})
