import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  define: {
    "import.meta.env.DEV": "true",
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/__tests__/setup.ts"],
    css: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
