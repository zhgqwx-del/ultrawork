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
import { loadSidecarPorts } from "./lib/sidecar-ports"
import { loadSidecarCredentials } from "./lib/sidecar-auth"
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

// Startup gate: sidecar ports AND credentials are resolved before the first
// render, so every base-URL / auth-header helper downstream stays synchronous and
// no provider has to model a "not known yet" state. Neither loader rejects —
// outside Tauri they fall back — so this cannot wedge the boot.
//
// The host holds `get_sidecar_ports` until opencode is healthy, so this still gates the
// first render on a live backend, exactly as it did when startup blocked the main
// thread. What changed is that the main thread is now free while it waits, so the
// webview parses its bundle *alongside* the engine boot instead of after it — and the
// splash is on screen for all of it.
Promise.all([loadSidecarPorts(), loadSidecarCredentials()]).then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
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
