import type { ProviderStatus } from '@orion/shared'

/**
 * Contratos dos adapters de provedores externos. Cada adapter declara
 * capacidades e limites; o restante do sistema nunca chama a API de um
 * provedor diretamente. Chaves vivem apenas no processo do servidor/worker.
 */

export type Env = Record<string, string | undefined>

export interface Pricing {
  /** centavos de USD; null = sem dado confiável */
  perSecondCents?: number | null
  perImageCents?: number | null
  per1kCharsCents?: number | null
  perMinuteCents?: number | null
  per1kTokensCents?: number | null
  /** de onde veio o preço e quando foi conferido */
  source?: string
  verifiedAt?: string
}

export interface VideoModel {
  id: string
  label: string
  modes: Array<'text-to-video' | 'image-to-video'>
  durations: number[]
  resolutions: Array<'720p' | '1080p'>
  aspects: Array<'16:9' | '9:16'>
  audio: boolean
  references: boolean
  seeds: boolean
  extension: boolean
  inputFormats: string[]
  outputFormats: string[]
  notes: string
}

export interface ImageModel {
  id: string
  label: string
  aspects: Array<'16:9' | '9:16' | '1:1' | '4:5'>
  outputFormats: string[]
  notes: string
}

export interface Estimate {
  cents: number | null
  basis: string
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'config' | 'quota' | 'unavailable' | 'invalid' | 'remote' | 'canceled',
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
  ) {
    super(message)
  }
}

export interface PollResult {
  state: 'running' | 'succeeded' | 'failed'
  progress?: number
  error?: string
  /** dado opaco para download */
  result?: unknown
}

export interface VideoStartInput {
  model: string
  mode: 'text-to-video' | 'image-to-video'
  prompt: string
  negativePrompt?: string
  durationSeconds: number
  aspect: '16:9' | '9:16'
  resolution: '720p' | '1080p'
  seed?: number
  image?: { bytes: Buffer; mimeType: string }
}

export interface VideoAdapter {
  id: string
  label: string
  status(env: Env): ProviderStatus
  models(): VideoModel[]
  estimate(model: string, durationSeconds: number, pricing: Pricing | undefined): Estimate
  start(input: VideoStartInput, env: Env): Promise<{ remoteId: string }>
  poll(remoteId: string, env: Env): Promise<PollResult>
  download(result: unknown, dst: string, env: Env): Promise<void>
  cancel?(remoteId: string, env: Env): Promise<boolean>
}

export interface ImageAdapter {
  id: string
  label: string
  status(env: Env): ProviderStatus
  models(): ImageModel[]
  estimate(model: string, pricing: Pricing | undefined): Estimate
  generate(input: { model: string; prompt: string; aspect: ImageModel['aspects'][number] }, dst: string, env: Env): Promise<void>
}

export interface Voice {
  id: string
  name: string
  language: string | null
  previewUrl: string | null
  labels: Record<string, string>
}

export interface TtsResult {
  /** alinhamento por caractere fornecido pelo provedor (null se não houver) */
  alignment: { characters: string[]; starts: number[]; ends: number[] } | null
  format: 'mp3' | 'wav'
}

export interface TtsAdapter {
  id: string
  label: string
  status(env: Env): ProviderStatus
  models(): Array<{ id: string; label: string; languages: string[]; timestamps: boolean; speedRange: [number, number] }>
  voices(env: Env): Promise<Voice[]>
  estimate(model: string, text: string, pricing: Pricing | undefined): Estimate
  synthesize(input: { model: string; voiceId: string; text: string; speed: number; pronunciationDictionaryIds?: string[] }, dst: string, env: Env): Promise<TtsResult>
}

export interface TranscriptWord {
  text: string
  start: number
  end: number
}

export interface TranscriptionResult {
  text: string
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>
  /** palavras com tempo (segundos) quando o provedor fornece */
  words: TranscriptWord[] | null
}

export interface TranscriptionAdapter {
  id: string
  label: string
  status(env: Env): ProviderStatus
  models(): Array<{ id: string; label: string; wordTimestamps: boolean; diarization: boolean; maxBytes: number }>
  estimate(model: string, durationSeconds: number, pricing: Pricing | undefined): Estimate
  transcribe(input: { model: string; path: string; language: string }, env: Env): Promise<TranscriptionResult>
}

export interface ScriptAdapter {
  id: string
  label: string
  status(env: Env): ProviderStatus
  complete(input: { system: string; prompt: string; maxTokens: number }, env: Env): Promise<string>
}

export function missing(env: Env, keys: string[]): string[] {
  return keys.filter((k) => !env[k] || env[k]!.trim() === '')
}

export function centsFor(rate: number | null | undefined, units: number, label: string, pricing?: Pricing): Estimate {
  if (rate === null || rate === undefined) {
    return { cents: null, basis: 'Sem dado confiável de preço. Configure packages/providers/pricing.json com fonte e data.' }
  }
  return {
    cents: Math.ceil(rate * units),
    basis: `${units} ${label} × ${rate} ¢ (fonte: ${pricing?.source ?? 'configuração'}${pricing?.verifiedAt ? `, conferido em ${pricing.verifiedAt}` : ''})`,
  }
}
