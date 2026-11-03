import { z } from 'zod'
import { AspectPreset, CaptionStyle, TextStyle, Transform } from './doc.ts'

/**
 * Templates são DADOS versionados e validados por schema.
 * Tempos de template são em segundos (decimais) porque o template é
 * independente de frame rate; ao aplicar, tudo é quantizado para frames
 * do projeto (packages/timeline/src/templates.ts).
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const TemplateField = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().max(80),
  type: z.enum(['text', 'media']),
  default: z.string().max(500),
  maxLength: z.number().int().positive().max(2000).optional(),
})
export type TemplateField = z.infer<typeof TemplateField>

export const TemplateElement = z.object({
  track: z.enum(['video', 'overlay', 'text']),
  kind: z.enum(['media-slot', 'text', 'color']),
  /** campo substituível (obrigatório para media-slot e text com field) */
  field: z.string().optional(),
  text: z.string().max(500).optional(),
  color: hex.optional(),
  style: TextStyle.partial().optional(),
  transform: Transform.partial().optional(),
  animation: z.enum(['none', 'fade', 'slide-up', 'pop']).optional(),
  zoom: z.enum(['none', 'in', 'out']).optional(),
  /** início relativo à cena, segundos */
  offset: z.number().min(0).max(600),
  /** duração; null = até o fim da cena */
  duration: z.number().positive().max(600).nullable(),
  transitionIn: z.enum(['fade', 'dissolve']).optional(),
})
export type TemplateElement = z.infer<typeof TemplateElement>

export const TemplateScene = z.object({
  key: z.string().max(40),
  title: z.string().max(80),
  duration: z.number().min(0.5).max(600),
  narrationHint: z.string().max(400),
  elements: z.array(TemplateElement).max(20),
})
export type TemplateScene = z.infer<typeof TemplateScene>

export const TemplateDefinition = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  name: z.string().max(80),
  category: z.enum([
    'reflexao',
    'vendas',
    'institucional',
    'historia',
    'educativo',
    'podcast',
    'depoimento',
    'lista',
    'produto',
    'humor',
    'personalizado',
  ]),
  description: z.string().max(400),
  version: z.number().int().positive(),
  aspects: z.array(AspectPreset).min(1),
  colors: z.object({
    background: hex,
    primary: hex,
    accent: hex,
    text: hex,
  }),
  fonts: z.object({
    heading: z.enum(['Inter', 'Inter Display']),
    body: z.enum(['Inter', 'Inter Display']),
  }),
  captionStyle: CaptionStyle.omit({ id: true, name: true }),
  durationRules: z.object({
    minSeconds: z.number().positive(),
    maxSeconds: z.number().positive(),
    /** como ajustar quando o conteúdo exceder: estica a cena "flex" */
    flexSceneKey: z.string().optional(),
  }),
  music: z.object({
    mood: z.string().max(40),
    volume: z.number().min(0).max(1),
    duckUnderVoice: z.boolean(),
  }),
  fields: z.array(TemplateField).max(40),
  scenes: z.array(TemplateScene).min(1).max(60),
  metadata: z.object({
    author: z.string().max(80),
    license: z.string().max(80),
    tags: z.array(z.string().max(30)).max(12),
  }),
})
export type TemplateDefinition = z.infer<typeof TemplateDefinition>
