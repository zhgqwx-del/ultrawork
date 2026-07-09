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

// Startup gate: sidecar ports are resolved before the first render, so every
// base-URL helper downstream stays synchronous and no provider has to model a
// "ports not known yet" state. `loadSidecarPorts` never rejects — outside Tauri
// it falls back to the preferred ports — so this cannot wedge the boot.
loadSidecarPorts().then(() => {
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
