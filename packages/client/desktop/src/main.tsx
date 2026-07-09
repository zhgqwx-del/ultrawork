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
import { router } from "./router"
import { loadSidecarPorts } from "./lib/sidecar-ports"
import { loadSidecarCredentials } from "./lib/sidecar-auth"
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

// Startup gate: sidecar ports AND credentials are resolved before the first
// render, so every base-URL / auth-header helper downstream stays synchronous and
// no provider has to model a "not known yet" state. Neither loader rejects —
// outside Tauri they fall back — so this cannot wedge the boot.
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
                    <RouterProvider router={router} />
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
})
