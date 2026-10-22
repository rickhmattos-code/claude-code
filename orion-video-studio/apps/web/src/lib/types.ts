import type { ProviderStatus } from '@orion/shared'

export interface AssetDto {
  id: string
  workspaceId: string
  kind: 'VIDEO' | 'AUDIO' | 'IMAGE' | 'SUBTITLE'
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED'
  source: string
  mimeType: string
  sizeBytes: number | null
  originalName: string
  durationFlicks: number | null
  width: number | null
  height: number | null
  fps: { num: number; den: number } | null
  variableFrameRate: boolean
  rotation: number
  hasVideo: boolean
  hasAudio: boolean
  error: string | null
  createdAt: string
  originalUrl: string | null
  proxyUrl: string | null
  proxyWebmUrl: string | null
  thumbnailUrl: string | null
  waveformUrl: string | null
}

export interface Workspace {
  id: string
  name: string
  role: 'OWNER' | 'EDITOR' | 'VIEWER'
  plan: string
}

export interface Me {
  user: { id: string; email: string; name: string } | null
  workspaces: Workspace[]
}

export interface RenderDto {
  id: string
  projectId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  progress: number
  stage: string | null
  preset: { resolution: string; captions: string; normalizeLoudness: boolean }
  error: string | null
  validation: null | { ok: boolean; checks: Array<{ name: string; ok: boolean; expected: string; actual: string }>; durationSeconds: number; sizeBytes: number }
  createdAt: string
  finishedAt: string | null
  downloadUrl?: string
  previewUrl?: string
  srtUrl?: string
  vttUrl?: string
  projectName?: string
}

export interface GenerationDto {
  id: string
  projectId: string | null
  kind: 'VIDEO' | 'IMAGE' | 'TTS' | 'TRANSCRIPTION' | 'SCRIPT' | 'MUSIC'
  provider: string
  model: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  input: Record<string, unknown>
  sceneKey: string | null
  estimatedCostCents: number
  confirmedCostCents: number | null
  resultAssetId: string | null
  result: Record<string, unknown> | null
  error: string | null
  approved: boolean
  createdAt: string
  reused?: boolean
}

export interface ProvidersDto {
  statuses: ProviderStatus[]
  video: Array<{ id: string; label: string; configured: boolean; mode: string; models: Array<{ id: string; label: string; modes: string[]; durations: number[]; resolutions: string[]; aspects: string[]; audio: boolean; notes: string }> }>
  image: Array<{ id: string; label: string; configured: boolean; mode: string; models: Array<{ id: string; label: string; aspects: string[]; notes: string }> }>
  tts: Array<{ id: string; label: string; configured: boolean; mode: string; models: Array<{ id: string; label: string; timestamps: boolean; speedRange: [number, number] }> }>
  transcription: Array<{ id: string; label: string; configured: boolean; mode: string; models: Array<{ id: string; label: string; wordTimestamps: boolean }> }>
}

export interface MusicDto {
  id: string
  title: string
  artist: string
  genre: string
  mood: string
  bpm: number | null
  isSfx: boolean
  durationFlicks: number
  assetId: string
  url: string
  favorite: boolean
  mine: boolean
  license: { source: string; author: string; licenseName: string; licenseUrl: string | null; commercialUse: boolean; attributionRequired: boolean; attributionText: string | null; platformRestrictions: string | null; validUntil: string | null }
}
