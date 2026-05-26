import { defineConfig } from "vitest/config"

// Provide a default OPENCODE_SERVER_PASSWORD so bridge.ts's lazy credential
// check passes — tests mock the api-client so the value is never used.
if (!process.env.OPENCODE_SERVER_PASSWORD) {
  process.env.OPENCODE_SERVER_PASSWORD = "vitest-fixture-password"
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
