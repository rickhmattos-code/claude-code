import type { Effort, Settings } from './types.js'

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-5-5',
  // Chat replies are short; low effort keeps latency down. Raise it in the
  // options page if drafts need more care.
  effort: 'low',
  persona: '',
  language: 'português do Brasil',
  historyLimit: 30,
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high']

export function normalizeSettings(raw: Record<string, unknown>): Settings {
  const s = { ...DEFAULT_SETTINGS }
  if (typeof raw.apiKey === 'string') s.apiKey = raw.apiKey.trim()
  if (typeof raw.model === 'string' && raw.model.trim()) {
    s.model = raw.model.trim()
  }
  if (EFFORTS.includes(raw.effort as Effort)) s.effort = raw.effort as Effort
  if (typeof raw.persona === 'string') s.persona = raw.persona
  if (typeof raw.language === 'string' && raw.language.trim()) {
    s.language = raw.language.trim()
  }
  const limit = Number(raw.historyLimit)
  if (Number.isFinite(limit) && limit > 0) {
    s.historyLimit = Math.min(200, Math.floor(limit))
  }
  return s
}

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))
  return normalizeSettings(raw)
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ ...settings })
}
