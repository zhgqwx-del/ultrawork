import { Outlet, Navigate } from "react-router-dom"
import { SidebarProvider, LeftSidebar } from "@/components/layout"
import { SessionsProvider } from "@/lib/sessions-context"
import { TeamSessionsProvider } from "@/lib/team-sessions-context"
import { ErrorBoundary } from "@/components/error-boundary"
import { useWorkspace } from "@/lib/workspace-context"
import { DragRegion } from "@/components/layout/drag-region"

/**
 * Root layout - wraps all pages with shared sidebar context and sidebar UI.
 * Waits for workspace auto-init, then redirects to selector only if init failed.
 */
export function RootLayout() {
  const { confirmed, initializing } = useWorkspace()

  // Wait for auto-init to complete before deciding
  if (initializing) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--color-bg)]">
        <DragRegion />
      </div>
    )
  }

  // Redirect to workspace selector only if auto-init couldn't resolve a workspace
  if (!confirmed) {
    return <Navigate to="/workspace" replace />
  }

  return (
    <TeamSessionsProvider>
    <SessionsProvider>
      <SidebarProvider>
        <div className="flex h-screen overflow-hidden bg-[var(--sidebar-bg)]">
          <LeftSidebar />

          {/* Main content area - pages render here via Outlet */}
          <div className="my-1.5 mr-1.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-[var(--color-bg)] shadow-sm">
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </div>
        </div>
      </SidebarProvider>
    </SessionsProvider>
    </TeamSessionsProvider>
  )
}
