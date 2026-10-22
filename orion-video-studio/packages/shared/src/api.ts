import { z } from 'zod'
import { AspectPreset, FrameRate, TimelineDoc } from './doc.ts'
import { TemplateDefinition } from './template.ts'

/** Contratos HTTP compartilhados entre web, API e testes (fonte do OpenAPI). */

export const RegisterBody = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(100),
  password: z.string().min(10).max(200),
})
export const LoginBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
})

export const CreateProjectBody = z.object({
  name: z.string().min(1).max(120),
  aspect: AspectPreset,
  width: z.number().int().min(144).max(3840).optional(),
  height: z.number().int().min(144).max(3840).optional(),
  fps: FrameRate.optional(),
  templateId: z.string().uuid().optional(),
  fieldValues: z.record(z.string(), z.string().max(2000)).optional(),
})

export const SaveProjectBody = z.object({
  /** versão que o cliente editou; conflito => 409 */
  baseVersion: z.number().int().positive(),
  document: TimelineDoc,
  name: z.string().min(1).max(120).optional(),
})

export const CreateRevisionBody = z.object({
  reason: z.string().min(1).max(200),
})

export const ALLOWED_UPLOAD_MIME = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/aac',
  'audio/mp4',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/x-subrip',
  'text/vtt',
] as const

export const CreateUploadBody = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(ALLOWED_UPLOAD_MIME),
  sizeBytes: z.number().int().positive(),
  source: z.enum(['UPLOAD', 'RECORDING']).default('UPLOAD'),
})

export const CompleteUploadBody = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().max(200) }))
    .optional(),
})

export const DeriveAssetBody = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('reverse'),
    sourceIn: z.number().int().nonnegative(),
    duration: z.number().int().positive(),
  }),
  z.object({ op: z.literal('freeze'), at: z.number().int().nonnegative() }),
  z.object({ op: z.literal('extract-audio') }),
])

export const RenderPreset = z.object({
  resolution: z.enum(['720p', '1080p']),
  captions: z.enum(['none', 'burn', 'sidecar', 'both']),
  normalizeLoudness: z.boolean().default(true),
})
export type RenderPreset = z.infer<typeof RenderPreset>

export const CreateRenderBody = z.object({
  preset: RenderPreset,
  idempotencyKey: z.string().min(8).max(100),
})

export const GenerationRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('VIDEO'),
    provider: z.string(),
    model: z.string(),
    mode: z.enum(['text-to-video', 'image-to-video']),
    prompt: z.string().min(1).max(4000),
    negativePrompt: z.string().max(2000).optional(),
    imageAssetId: z.string().uuid().optional(),
    durationSeconds: z.number().int().min(1).max(60),
    aspect: z.enum(['16:9', '9:16']),
    resolution: z.enum(['720p', '1080p']),
    seed: z.number().int().nonnegative().optional(),
    characterIds: z.array(z.string().uuid()).max(4).default([]),
    sceneKey: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('IMAGE'),
    provider: z.string(),
    model: z.string(),
    prompt: z.string().min(1).max(4000),
    aspect: z.enum(['16:9', '9:16', '1:1', '4:5']),
    characterIds: z.array(z.string().uuid()).max(4).default([]),
    sceneKey: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('TTS'),
    provider: z.string(),
    model: z.string(),
    voiceId: z.string().min(1).max(100),
    text: z.string().min(1).max(5000),
    speed: z.number().min(0.7).max(1.2).default(1),
    /** chave de frase para regeneração isolada */
    sentenceKey: z.string().max(64).optional(),
    sceneKey: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('TRANSCRIPTION'),
    provider: z.string(),
    model: z.string(),
    assetId: z.string().uuid(),
    language: z.string().max(10).default('pt'),
  }),
])
export type GenerationRequest = z.infer<typeof GenerationRequest>

export const EstimateResponse = z.object({
  provider: z.string(),
  model: z.string(),
  configured: z.boolean(),
  /** null quando não há dado confiável de preço */
  estimatedCents: z.number().int().nullable(),
  basis: z.string(),
  remainingBudgetCents: z.number().int(),
})
export type EstimateResponse = z.infer<typeof EstimateResponse>

export const CreateGenerationBody = z.object({
  request: GenerationRequest,
  idempotencyKey: z.string().min(8).max(100),
  /** usuário confirma o teto estimado antes de operações pagas */
  acceptEstimatedCents: z.number().int().nonnegative().nullable(),
  projectId: z.string().uuid().optional(),
})

export const AssistantBrief = z.object({
  theme: z.string().min(3).max(500),
  audience: z.string().max(200),
  goal: z.string().max(200),
  durationSeconds: z.number().int().min(15).max(1800),
  aspect: AspectPreset,
  tone: z.string().max(80),
  visualStyle: z.string().max(200),
  voice: z.string().max(100).optional(),
  references: z.string().max(2000).optional(),
  script: z.string().max(40000).optional(),
})
export type AssistantBrief = z.infer<typeof AssistantBrief>

export const AssistantCommandBody = z.object({
  command: z.string().min(1).max(500),
  document: TimelineDoc,
  selectedClipId: z.string().optional(),
  playhead: z.number().int().nonnegative(),
  context: z
    .object({
      musicTrackIds: z.array(z.string()).optional(),
      brandKitId: z.string().optional(),
      voiceIds: z.array(z.string()).optional(),
    })
    .optional(),
})

export const SaveTemplateBody = z.object({ definition: TemplateDefinition })

const brandPalette = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})
export const BrandKitBody = z.object({
  name: z.string().min(1).max(80),
  displayName: z.string().min(1).max(120),
  socialHandle: z.string().max(60).optional(),
  signature: z.string().max(200).optional(),
  palette: brandPalette,
  fonts: z.object({
    heading: z.enum(['Inter', 'Inter Display']),
    body: z.enum(['Inter', 'Inter Display']),
  }),
  captionStyleOverrides: z
    .object({
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      highlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700), z.literal(800)]).optional(),
    })
    .default({}),
  logoAssetId: z.string().uuid().nullable().optional(),
  watermarkAssetId: z.string().uuid().nullable().optional(),
  introAssetId: z.string().uuid().nullable().optional(),
  outroAssetId: z.string().uuid().nullable().optional(),
})
export type BrandKitBody = z.infer<typeof BrandKitBody>

export const CharacterBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(1000),
  appearance: z.string().max(1000),
  wardrobe: z.string().max(500),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8),
  mustKeep: z.array(z.string().max(120)).max(12),
  continuityRules: z.string().max(1000),
  voiceProfileId: z.string().uuid().nullable().optional(),
  references: z
    .array(z.object({ assetId: z.string().uuid(), authorization: z.string().min(5).max(500) }))
    .max(8),
})
export type CharacterBody = z.infer<typeof CharacterBody>

export const VoiceProfileBody = z.object({
  name: z.string().min(1).max(80),
  provider: z.string().max(40),
  providerVoiceId: z.string().max(100),
  language: z.string().max(10).default('pt-BR'),
  settings: z.object({ speed: z.number().min(0.7).max(1.2).default(1) }).default({ speed: 1 }),
  isClone: z.boolean().default(false),
  consent: z
    .object({
      speakerName: z.string().min(2).max(120),
      grantedBy: z.string().min(2).max(120),
      grantedAt: z.string().datetime(),
      statement: z.string().min(20).max(2000),
    })
    .optional(),
})

export const MusicQuery = z.object({
  q: z.string().max(100).optional(),
  mood: z.string().max(40).optional(),
  genre: z.string().max(40).optional(),
  minSeconds: z.coerce.number().min(0).optional(),
  maxSeconds: z.coerce.number().min(0).optional(),
  minBpm: z.coerce.number().int().min(0).optional(),
  maxBpm: z.coerce.number().int().min(0).optional(),
  sfx: z.enum(['true', 'false']).optional(),
  favorites: z.enum(['true', 'false']).optional(),
})

export const RegisterUserMusicBody = z.object({
  assetId: z.string().uuid(),
  title: z.string().min(1).max(120),
  artist: z.string().max(120),
  genre: z.string().max(40),
  mood: z.string().max(40),
  bpm: z.number().int().min(20).max(300).optional(),
  isSfx: z.boolean().default(false),
  license: z.object({
    licenseName: z.string().min(2).max(120),
    commercialUse: z.boolean(),
    attributionRequired: z.boolean(),
    attributionText: z.string().max(300).optional(),
    platformRestrictions: z.string().max(300).optional(),
    /** usuário declara possuir os direitos de sincronização */
    declaration: z.literal(true),
  }),
})

export type ProviderStatus = {
  id: string
  label: string
  kinds: Array<'VIDEO' | 'IMAGE' | 'TTS' | 'TRANSCRIPTION' | 'SCRIPT' | 'MUSIC'>
  configured: boolean
  /** mock = provedor simulado, só em PROVIDERS_MOCK=1; UI exibe "MODO DE TESTE" */
  mode: 'live' | 'mock' | 'pending-config' | 'local'
  missingEnv: string[]
  notes: string
}
