import { Outlet, Navigate } from "react-router-dom"
import { SidebarProvider, LeftSidebar } from "@/components/layout"
import { SessionsProvider } from "@/lib/sessions-context"
import { ErrorBoundary } from "@/components/error-boundary"
import { useWorkspace } from "@/lib/workspace-context"

/**
 * Root layout - wraps all pages with shared sidebar context and sidebar UI.
 * Redirects to workspace selector if no workspace has been confirmed for this session.
 */
export function RootLayout() {
  const { confirmed } = useWorkspace()

  // Redirect to workspace selector if not yet confirmed this app session
  if (!confirmed) {
    return <Navigate to="/workspace" replace />
  }

  return (
    <SessionsProvider>
      <SidebarProvider>
        <div className="flex h-screen overflow-hidden bg-[var(--sidebar-bg)]">
          <LeftSidebar />

          {/* Main content area - pages render here via Outlet */}
          <div className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-bg)] shadow-sm">
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </div>
        </div>
      </SidebarProvider>
    </SessionsProvider>
  )
}
