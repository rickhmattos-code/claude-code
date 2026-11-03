import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderStatus } from '@orion/shared'
import { anthropicAdapter } from './anthropic.ts'
import { elevenLabsAdapter } from './elevenlabs.ts'
import { mockImageAdapter, mockTranscriptionAdapter, mockTtsAdapter, mockVideoAdapter } from './mock.ts'
import { openAiImageAdapter, openAiTranscriptionAdapter } from './openai.ts'
import type { Env, ImageAdapter, Pricing, ScriptAdapter, TranscriptionAdapter, TtsAdapter, VideoAdapter } from './types.ts'
import { veoAdapter } from './veo.ts'

export const VIDEO_ADAPTERS: VideoAdapter[] = [veoAdapter, mockVideoAdapter]
export const IMAGE_ADAPTERS: ImageAdapter[] = [openAiImageAdapter, mockImageAdapter]
export const TTS_ADAPTERS: TtsAdapter[] = [elevenLabsAdapter, mockTtsAdapter]
export const TRANSCRIPTION_ADAPTERS: TranscriptionAdapter[] = [openAiTranscriptionAdapter, mockTranscriptionAdapter]
export const SCRIPT_ADAPTERS: ScriptAdapter[] = [anthropicAdapter]

const isMock = (id: string) => id.startsWith('mock-')

/** Provedores simulados só aparecem quando PROVIDERS_MOCK=1. */
function visible<T extends { id: string }>(list: T[], env: Env): T[] {
  return list.filter((a) => !isMock(a.id) || env.PROVIDERS_MOCK === '1')
}

export function providerStatuses(env: Env): ProviderStatus[] {
  const out: ProviderStatus[] = []
  for (const a of [...visible(VIDEO_ADAPTERS, env), ...visible(IMAGE_ADAPTERS, env), ...visible(TTS_ADAPTERS, env), ...visible(TRANSCRIPTION_ADAPTERS, env), ...SCRIPT_ADAPTERS]) {
    out.push(a.status(env))
  }
  out.push({
    id: 'local-storyboard',
    label: 'Organizador de roteiro local',
    kinds: ['SCRIPT'],
    configured: true,
    mode: 'local',
    missingEnv: [],
    notes: 'Divide roteiros em cenas e estima durações sem IA. Sempre disponível.',
  })
  out.push({
    id: 'music-generation',
    label: 'Geração musical',
    kinds: ['MUSIC'],
    configured: false,
    mode: 'pending-config',
    missingEnv: ['adapter não implementado'],
    notes: 'Interface pronta (MusicAdapter). Será ativada apenas com API oficial, credenciais e termos que permitam sincronização comercial.',
  })
  return out
}

export function findVideo(id: string, env: Env) {
  return visible(VIDEO_ADAPTERS, env).find((a) => a.id === id)
}
export function findImage(id: string, env: Env) {
  return visible(IMAGE_ADAPTERS, env).find((a) => a.id === id)
}
export function findTts(id: string, env: Env) {
  return visible(TTS_ADAPTERS, env).find((a) => a.id === id)
}
export function findTranscription(id: string, env: Env) {
  return visible(TRANSCRIPTION_ADAPTERS, env).find((a) => a.id === id)
}
export function scriptAdapter(env: Env): ScriptAdapter | null {
  const a = SCRIPT_ADAPTERS[0]!
  return a.status(env).configured ? a : null
}

type PricingFile = Record<string, Record<string, Pricing>>
let cached: PricingFile | null = null

export function loadPricing(env: Env): PricingFile {
  if (cached) return cached
  const path = env.PRICING_FILE || join(dirname(fileURLToPath(import.meta.url)), '../pricing.json')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  delete raw._comment
  cached = raw as PricingFile
  return cached
}

export function pricingFor(env: Env, provider: string, model: string): Pricing | undefined {
  return loadPricing(env)[provider]?.[model]
}

/**
 * Dicionário de pronúncia local: substituições aplicadas ao texto antes do
 * TTS (funciona com qualquer provedor). Ex.: { "ORION": "Órion" }.
 */
export function applyPronunciation(text: string, dict: Record<string, string>): string {
  let out = text
  for (const [from, to] of Object.entries(dict)) {
    if (!from.trim()) continue
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), to)
  }
  return out
}
