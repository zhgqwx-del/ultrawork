import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router-dom"
import { Toaster } from "sonner"
import { ConfigProvider } from "./lib/config-context"
import { ThemeProvider, useTheme } from "./lib/theme-context"
import { I18nProvider } from "./lib/i18n-context"
import { ModelProvider, useModel } from "./lib/model-context"
import { WorkspaceProvider } from "./lib/workspace-context"
import { SSEProvider } from "./lib/sse-context"
import { AgentProvider } from "./lib/agent-context"
import { ModelDialog } from "./components/settings/model-dialog"
import { router } from "./router"
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

function ModelDialogSingleton() {
  const { currentModel, setModel, modelDialogOpen, closeModelDialog } = useModel()
  return (
    <ModelDialog
      open={modelDialogOpen}
      onOpenChange={(open) => { if (!open) closeModelDialog() }}
      currentModel={currentModel}
      onModelChange={setModel}
    />
  )
}

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
                  <ModelDialogSingleton />
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
