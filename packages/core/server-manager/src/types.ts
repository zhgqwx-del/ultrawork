export interface ServerConfig {
  binaryPath: string
  workingDir: string
  port?: number
  password?: string
}

export interface ServerInfo {
  pid: number
  port: number
  password: string
  startedAt: Date
}

export type ServerStatus = "stopped" | "starting" | "running" | "error"
