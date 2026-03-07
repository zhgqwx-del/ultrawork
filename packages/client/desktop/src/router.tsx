import { createBrowserRouter, useRouteError } from "react-router-dom"
import { RootLayout } from "@/components/layout"
import { HomePage, SessionPage, SettingsPage, WorkspaceSelectorPage } from "@/pages"
import { AlertTriangle, RefreshCw } from "lucide-react"

function RouteErrorFallback() {
  const error = useRouteError() as Error | null

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg)] p-8">
      <AlertTriangle className="h-12 w-12 text-orange-500" />
      <h2 className="text-lg font-semibold text-[var(--color-fg)]">
        Something went wrong
      </h2>
      <p className="max-w-md text-center text-sm text-[var(--color-fg-muted)]">
        {error?.message || "An unexpected error occurred."}
      </p>
      <button
        onClick={() => window.location.reload()}
        className="flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white transition-colors hover:opacity-90"
      >
        <RefreshCw className="h-4 w-4" />
        Reload
      </button>
    </div>
  )
}

export const router = createBrowserRouter([
  {
    path: "/workspace",
    element: <WorkspaceSelectorPage />,
    errorElement: <RouteErrorFallback />,
  },
  {
    element: <RootLayout />,
    errorElement: <RouteErrorFallback />,
    children: [
      {
        path: "/",
        element: <HomePage />,
      },
      {
        path: "/session/:id",
        element: <SessionPage />,
      },
      {
        path: "/settings",
        element: <SettingsPage />,
      },
    ],
  },
])
