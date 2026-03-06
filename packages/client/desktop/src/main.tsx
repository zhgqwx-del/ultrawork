import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router-dom"
import { ConfigProvider } from "./lib/config-context"
import { ThemeProvider } from "./lib/theme-context"
import { I18nProvider } from "./lib/i18n-context"
import { router } from "./router"
import "./index.css"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider>
      <ThemeProvider>
        <I18nProvider>
          <RouterProvider router={router} />
        </I18nProvider>
      </ThemeProvider>
    </ConfigProvider>
  </React.StrictMode>
)
