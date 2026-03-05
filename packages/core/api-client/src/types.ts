// OpenCode API Types

export interface ApiClientConfig {
  baseUrl: string
  username?: string
  password?: string
}

export interface SessionCreateRequest {
  agent?: string
  workingDirectory?: string
}

export interface SessionCreateResponse {
  id: string
  slug: string
  version: string
  projectID: string
  directory: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export interface MessagePart {
  type: string
  text?: string
  [key: string]: any
}

export interface SendMessageRequest {
  parts: MessagePart[]
}

export interface MessageInfo {
  role: "user" | "assistant"
  time: {
    created: number
    completed?: number
  }
  parentID?: string
  modelID?: string
  providerID?: string
  mode?: string
  agent?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    total?: number
  }
  finish?: string
  id: string
  sessionID: string
}

export interface SendMessageResponse {
  info: MessageInfo
  parts: MessagePart[]
}

export interface Message {
  role: "user" | "assistant"
  content: string
}

export interface Session {
  id: string
  slug: string
  version: string
  projectID: string
  directory: string
  title: string
  time: {
    created: number
    updated: number
  }
  messages?: Message[]
}
