import { spawn, type ChildProcess } from "child_process"
import type { ServerConfig, ServerInfo, ServerStatus } from "./types"

export class ServerManager {
  private process: ChildProcess | null = null
  private config: ServerConfig
  private status: ServerStatus = "stopped"
  private info: ServerInfo | null = null

  constructor(config: ServerConfig) {
    this.config = config
  }

  async start(): Promise<ServerInfo> {
    if (this.status === "running") {
      throw new Error("Server is already running")
    }

    this.status = "starting"

    const port = this.config.port || 4096
    const password = this.config.password || this.generatePassword()

    this.process = spawn(this.config.binaryPath, ["serve", "--port", port.toString()], {
      cwd: this.config.workingDir,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    })

    this.process.on("error", (error) => {
      console.error("Server process error:", error)
      this.status = "error"
    })

    this.process.on("exit", (code) => {
      console.log(`Server process exited with code ${code}`)
      this.status = "stopped"
      this.process = null
    })

    await this.waitForReady(port)

    this.info = {
      pid: this.process.pid!,
      port,
      password,
      startedAt: new Date(),
    }

    this.status = "running"
    return this.info
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return
    }

    this.process.kill()
    this.process = null
    this.status = "stopped"
    this.info = null
  }

  getStatus(): ServerStatus {
    return this.status
  }

  getInfo(): ServerInfo | null {
    return this.info
  }

  private async waitForReady(port: number, timeout = 30000): Promise<void> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`)
        if (response.ok) {
          return
        }
      } catch {
        // Server not ready yet
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    throw new Error("Server failed to start within timeout")
  }

  private generatePassword(): string {
    return Math.random().toString(36).substring(2, 15)
  }
}

export function createServerManager(config: ServerConfig): ServerManager {
  return new ServerManager(config)
}
