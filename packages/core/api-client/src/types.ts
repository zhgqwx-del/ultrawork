// OpenCode API Types
export interface SessionCreateRequest {
  agent?: string
  workingDirectory?: string
}

export interface SessionCreateResponse {
  id: string
  agent: string
  workingDirectory: string
}

export interface SessionPromptRequest {
  prompt: string
}

export interface Message {
  role: "user" | "assistant"
  content: string
}

export interface Session {
  id: string
  messages: Message[]
}

export interface ApiClientConfig {
  baseUrl: string
  password?: string
}
