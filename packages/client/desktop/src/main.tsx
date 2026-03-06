import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router-dom"
import { Toaster } from "sonner"
import { ConfigProvider } from "./lib/config-context"
import { ThemeProvider, useTheme } from "./lib/theme-context"
import { I18nProvider } from "./lib/i18n-context"
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider>
      <ThemeProvider>
        <I18nProvider>
          <RouterProvider router={router} />
          <ThemedToaster />
        </I18nProvider>
      </ThemeProvider>
    </ConfigProvider>
  </React.StrictMode>
)
