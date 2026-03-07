import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "path"

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
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/event": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/session": {
        target: "http://localhost:4096",
        changeOrigin: true,
        timeout: 300000,
      },
      "/permission": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/question": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/global": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/config": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/provider": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/auth": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/agent": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/mcp": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/skill": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/command": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/file": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/project": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
      "/experimental": {
        target: "http://localhost:4096",
        changeOrigin: true,
      },
    },
  },
})
