import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router-dom"
import { Toaster } from "sonner"
import { ConfigProvider } from "./lib/config-context"
import { ThemeProvider, useTheme } from "./lib/theme-context"
import { I18nProvider } from "./lib/i18n-context"
import { ModelProvider } from "./lib/model-context"
import { WorkspaceProvider } from "./lib/workspace-context"
import { SSEProvider } from "./lib/sse-context"
import { AgentProvider } from "./lib/agent-context"
import { DraftProvider } from "./lib/draft-context"
import { router } from "./router"
import { openStartupGate } from "./lib/startup-gate"
import { StartupBlocked } from "./components/startup-blocked"
import { beginBootTracking, dismissSplashWhenReady } from "./lib/boot-splash"
import "./index.css"

function ThemedToaster() {
  const { resolvedTheme } = useTheme()
  return (
    <Toaster
      position="top-right"
      theme={resolvedTheme}
      richColors
      toastOptions={{
        className: "text-sm",
      }}
    />
  )
}

// Narrate the splash from here on. This MUST come before the startup gate below, not
// inside it: the gate only opens once the engine is up, so a listener attached after it
// would have missed every intermediate stage and could only ever see the final one —
// leaving the splash stuck on its hardcoded first line for the entire boot, and the
// stage texts unreachable (discussions/038).
beginBootTracking()

// Native ownership is checked before credential or port IPC and before mounting
// any business provider. A blocked startup renders only the diagnostic screen;
// browser fixtures explicitly opt into their existing standalone test context.
openStartupGate().then((status) => {
  const root = ReactDOM.createRoot(document.getElementById("root")!)
  if (status.state === "blocked") {
    root.render(<StartupBlocked status={status} />)
    dismissSplashWhenReady()
    return
  }
  root.render(
    <React.StrictMode>
      <ConfigProvider>
        <ThemeProvider>
          <I18nProvider>
            <WorkspaceProvider>
              <SSEProvider>
                <AgentProvider>
                  <ModelProvider>
                    {/* OUTSIDE RouterProvider on purpose: composer drafts have to outlive
                        the unmount that every route change performs on the page under
                        <Outlet> (discussions/060). */}
                    <DraftProvider>
                      <RouterProvider router={router} />
                    </DraftProvider>
                  </ModelProvider>
                </AgentProvider>
              </SSEProvider>
            </WorkspaceProvider>
            <ThemedToaster />
          </I18nProvider>
        </ThemeProvider>
      </ConfigProvider>
    </React.StrictMode>
  )

  dismissSplashWhenReady()
})
