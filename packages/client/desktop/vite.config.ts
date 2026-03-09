import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "path"

// Shared proxy target configs
const backend = { target: "http://localhost:4096", changeOrigin: true }
const gateway = { target: "http://localhost:4097", changeOrigin: true }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Ignore Tauri source and OpenCode config files to prevent HMR reload
      ignored: ["**/src-tauri/**", "**/config.json", "**/.opencode/**"],
    },
    proxy: {
      "/event": backend,
      // /session proxy: only match API calls, not SPA routes like /session/ses_xxx
      // API routes always have a sub-path after the session ID (e.g. /session/ID/message)
      // or are exact /session (list) or /session with POST (create)
      "/session": {
        ...backend,
        timeout: 300000,
        // Bypass proxy for browser navigation requests (HTML pages)
        // so Vite SPA fallback serves index.html instead
        bypass(req) {
          // Browser navigation/page requests accept text/html
          const accept = req.headers.accept || ""
          if (accept.includes("text/html")) {
            return req.url // return the URL to skip proxy and let Vite handle it
          }
        },
      },
      "/permission": backend,
      "/question": backend,
      "/health": backend,
      "/global": backend,
      "/config": backend,
      "/provider": backend,
      "/auth": backend,
      "/agent": backend,
      "/mcp": backend,
      "/skill": backend,
      "/command": backend,
      "/file": backend,
      "/project": backend,
      "/experimental": backend,
      // Channel gateway proxy → :4097
      "/channel": gateway,
    },
  },
})
