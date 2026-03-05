import { Outlet } from "react-router-dom"
import { SidebarProvider, LeftSidebar } from "@/components/layout"

/**
 * Root layout - wraps all pages with shared sidebar context and sidebar UI.
 * This ensures sidebar state (open/closed) persists across route changes.
 */
export function RootLayout() {
  return (
    <SidebarProvider>
      <div className="flex h-screen overflow-hidden bg-[--sidebar-bg]">
        <LeftSidebar />

        {/* Main content area - pages render here via Outlet */}
        <div className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[--color-bg] shadow-sm">
          <Outlet />
        </div>
      </div>
    </SidebarProvider>
  )
}
