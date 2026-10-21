export interface ChatMessage {
  fromMe: boolean
  author: string
  time: string
  text: string
}

export interface ChatSnapshot {
  title: string
  messages: ChatMessage[]
}

export type GenerateMode = 'reply' | 'summary'

export interface GenerateRequest {
  type: 'claude:generate'
  mode: GenerateMode
  chat: ChatSnapshot
  instruction: string
}

export type GenerateResponse =
  | { ok: true; text: string }
  | { ok: false; error: string }

export type Effort = 'low' | 'medium' | 'high'

export interface Settings {
  apiKey: string
  model: string
  effort: Effort
  persona: string
  language: string
  historyLimit: number
}

export function isGenerateRequest(value: unknown): value is GenerateRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.type === 'claude:generate' &&
    (v.mode === 'reply' || v.mode === 'summary') &&
    typeof v.instruction === 'string' &&
    typeof v.chat === 'object' &&
    v.chat !== null
  )
}
