import { Outlet } from "react-router-dom"
import { SidebarProvider, LeftSidebar } from "@/components/layout"
import { SessionsProvider } from "@/lib/sessions-context"
import { ErrorBoundary } from "@/components/error-boundary"

/**
 * Root layout - wraps all pages with shared sidebar context and sidebar UI.
 * This ensures sidebar state (open/closed) and sessions persist across route changes.
 */
export function RootLayout() {
  return (
    <SessionsProvider>
      <SidebarProvider>
        <div className="flex h-screen overflow-hidden bg-[--sidebar-bg]">
          <LeftSidebar />

          {/* Main content area - pages render here via Outlet */}
          <div className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[--color-bg] shadow-sm">
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </div>
        </div>
      </SidebarProvider>
    </SessionsProvider>
  )
}
