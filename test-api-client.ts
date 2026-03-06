#!/usr/bin/env bun
import { createApiClient } from "./packages/core/api-client/src/client"

async function test() {
  const client = createApiClient({
    baseUrl: "http://localhost:4096",
    password: "test123",
  })

  try {
    console.log("Creating session...")
    const session = await client.createSession({
      workingDirectory: process.cwd(),
    })
    console.log("✅ Session created:", session.id)

    console.log("\nSending message...")
    await client.sendMessage(session.id, "Hello, OpenCode!")
    console.log("✅ Message sent")

    console.log("\nTest completed successfully!")
  } catch (error) {
    console.error("❌ Test failed:", error)
    process.exit(1)
  }
}

test()
