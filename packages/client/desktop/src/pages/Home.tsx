import { SidebarProvider, LeftSidebar } from "@/components/layout"

export function HomePage() {
  return (
    <SidebarProvider>
      <HomeContent />
    </SidebarProvider>
  )
}

function HomeContent() {
  return (
    <div className="flex h-screen overflow-hidden bg-[--sidebar-bg]">
      <LeftSidebar />

      {/* Main Content */}
      <div className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[--color-bg] shadow-sm">
        {/* Vertically Centered */}
        <div className="flex flex-1 flex-col items-center justify-center overflow-auto px-4">
          <div className="flex w-full max-w-2xl flex-col items-center gap-6">
            {/* Title */}
            <h1 className="text-center text-4xl font-normal tracking-tight text-[--color-fg] md:text-5xl">
              What can I help you with?
            </h1>

            {/* Input placeholder - will be replaced with ChatInput in 2.5 */}
            <div className="w-full rounded-2xl border border-[--color-border] bg-[--color-bg] p-4 shadow-lg">
              <textarea
                placeholder="Ask anything..."
                className="w-full resize-none border-0 bg-transparent text-base text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none"
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    // Will navigate to /session/:id in 2.2
                  }
                }}
              />
              <div className="mt-3 flex items-center justify-end">
                <button className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-[--color-fg-muted] text-[--color-bg] transition-all">
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
