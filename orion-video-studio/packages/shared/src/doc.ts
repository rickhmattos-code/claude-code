import { z } from 'zod'

/**
 * Documento de edição (TimelineDoc).
 *
 * Todas as grandezas temporais são inteiros em FLICKS (1/705.600.000 s),
 * base escolhida porque divide exatamente todos os frame rates suportados
 * (23.976, 24, 25, 29.97, 30, 50, 59.94, 60) e todas as taxas de amostragem
 * de áudio comuns (8k … 192k). Veja packages/timeline/src/time.ts.
 */

export const DOC_SCHEMA_VERSION = 1

const flicks = z.number().int().nonnegative().refine(Number.isSafeInteger, {
  message: 'tempo fora do intervalo seguro',
})
const signedFlicks = z.number().int().refine(Number.isSafeInteger)
const id = z.string().min(1).max(64)
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)

export const FrameRate = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
})
export type FrameRate = z.infer<typeof FrameRate>

export const AspectPreset = z.enum(['9:16', '16:9', '1:1', '4:5', 'custom'])
export type AspectPreset = z.infer<typeof AspectPreset>

export const ProjectSettings = z.object({
  aspect: AspectPreset,
  width: z.number().int().min(144).max(3840),
  height: z.number().int().min(144).max(3840),
  fps: FrameRate,
  sampleRate: z.literal(48000),
  background: hexColor,
})
export type ProjectSettings = z.infer<typeof ProjectSettings>

export const KeyframeProperty = z.enum([
  'opacity',
  'scale',
  'x',
  'y',
  'rotation',
  'volume',
])
export type KeyframeProperty = z.infer<typeof KeyframeProperty>

export const Easing = z.enum(['linear', 'hold', 'easeInOut'])
export type Easing = z.infer<typeof Easing>

export const Keyframe = z.object({
  id,
  property: KeyframeProperty,
  /** relativo ao início do clipe */
  time: flicks,
  value: z.number().finite(),
  easing: Easing,
})
export type Keyframe = z.infer<typeof Keyframe>

export const Transform = z.object({
  /** centro horizontal, fração da largura do quadro (0.5 = centro) */
  x: z.number().min(-2).max(3),
  /** centro vertical, fração da altura do quadro (0.5 = centro) */
  y: z.number().min(-2).max(3),
  /** 1 = tamanho definido pelo modo de ajuste (fit) */
  scale: z.number().min(0.05).max(10),
  /** graus, sentido horário */
  rotation: z.number().min(-3600).max(3600),
  opacity: z.number().min(0).max(1),
})
export type Transform = z.infer<typeof Transform>

export const DEFAULT_TRANSFORM: Transform = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
}

// ---------------------------------------------------------------------------
// Efeitos: cada tipo tem parâmetros tipados com limites. A matriz de suporte
// (prévia × exportação) fica em packages/shared/src/effects.ts.
// ---------------------------------------------------------------------------

export const Effect = z.discriminatedUnion('type', [
  z.object({
    id,
    type: z.literal('color'),
    brightness: z.number().min(-1).max(1),
    contrast: z.number().min(0).max(3),
    saturation: z.number().min(0).max(3),
  }),
  z.object({
    id,
    type: z.literal('temperature'),
    kelvin: z.number().int().min(2000).max(12000),
  }),
  z.object({ id, type: z.literal('blur'), radius: z.number().min(0).max(40) }),
  z.object({
    id,
    type: z.literal('vignette'),
    strength: z.number().min(0).max(1),
  }),
  z.object({ id, type: z.literal('grain'), amount: z.number().min(0).max(1) }),
  z.object({
    id,
    type: z.literal('chromakey'),
    color: hexColor,
    similarity: z.number().min(0.01).max(1),
    blend: z.number().min(0).max(1),
  }),
  z.object({
    id,
    type: z.literal('mask'),
    shape: z.enum(['rect', 'ellipse']),
    /** centro e tamanho como fração do quadro do clipe (após o ajuste cover/contain) */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.01).max(1),
    h: z.number().min(0.01).max(1),
    /** borda suave, fração do menor lado do clipe */
    feather: z.number().min(0).max(0.25),
    invert: z.boolean(),
  }),
  z.object({
    id,
    type: z.literal('denoise'),
    /** redução de ruído de áudio (afftdn), dB */
    reductionDb: z.number().min(1).max(40),
  }),
])
export type Effect = z.infer<typeof Effect>
export type EffectType = Effect['type']

export const Transition = z.object({
  type: z.enum(['fade', 'dissolve']),
  duration: flicks,
})
export type Transition = z.infer<typeof Transition>

export const TextStyle = z.object({
  fontFamily: z.enum(['Inter', 'Inter Display']),
  fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700), z.literal(800)]),
  /** pixels relativos à altura de 1080 do quadro (escalado na renderização) */
  fontSize: z.number().min(8).max(400),
  color: hexColor,
  outlineColor: hexColor,
  outlineWidth: z.number().min(0).max(20),
  shadow: z.number().min(0).max(20),
  background: hexColor.nullable(),
  align: z.enum(['left', 'center', 'right']),
})
export type TextStyle = z.infer<typeof TextStyle>

const clipBase = {
  id,
  name: z.string().max(200),
  start: flicks,
  duration: flicks.refine((v) => v > 0, 'duração deve ser positiva'),
  /** cena do storyboard que originou o clipe (regeneração por cena) */
  sceneKey: z.string().max(64).optional(),
}

const visualProps = {
  transform: Transform,
  fit: z.enum(['cover', 'contain']),
  keyframes: z.array(Keyframe).max(500),
  effects: z.array(Effect).max(16),
  transitionIn: Transition.optional(),
}

export const MediaClip = z.object({
  ...clipBase,
  type: z.enum(['video', 'image', 'audio']),
  assetId: id,
  /** ponto de entrada no tempo da mídia de origem */
  sourceIn: flicks,
  speed: z.number().min(0.25).max(4),
  volume: z.number().min(0).max(2),
  fadeIn: flicks,
  fadeOut: flicks,
  ...visualProps,
})
export type MediaClip = z.infer<typeof MediaClip>

export const TextClip = z.object({
  ...clipBase,
  type: z.literal('text'),
  text: z.string().min(1).max(2000),
  style: TextStyle,
  animation: z.enum(['none', 'fade', 'slide-up', 'pop']),
  /** campo substituível de template (ex.: "titulo") */
  field: z.string().max(64).optional(),
  ...visualProps,
})
export type TextClip = z.infer<typeof TextClip>

export const ColorClip = z.object({
  ...clipBase,
  type: z.literal('color'),
  color: hexColor,
  ...visualProps,
})
export type ColorClip = z.infer<typeof ColorClip>

export const Clip = z.discriminatedUnion('type', [
  MediaClip.extend({ type: z.literal('video') }),
  MediaClip.extend({ type: z.literal('image') }),
  MediaClip.extend({ type: z.literal('audio') }),
  TextClip,
  ColorClip,
])
export type Clip = z.infer<typeof Clip>
export type AnyMediaClip = Extract<Clip, { type: 'video' | 'image' | 'audio' }>

export const TrackKind = z.enum(['video', 'overlay', 'text', 'audio', 'voice', 'music'])
export type TrackKind = z.infer<typeof TrackKind>

export const Track = z.object({
  id,
  kind: TrackKind,
  name: z.string().max(80),
  muted: z.boolean(),
  locked: z.boolean(),
  hidden: z.boolean(),
  solo: z.boolean(),
  volume: z.number().min(0).max(2),
  /** música: reduz automaticamente durante falas (trilhas voice) */
  duckUnderVoice: z.boolean(),
  clips: z.array(Clip).max(5000),
})
export type Track = z.infer<typeof Track>

export const CaptionWord = z.object({
  text: z.string(),
  start: flicks,
  end: flicks,
})

export const CaptionSegment = z.object({
  id,
  start: flicks,
  end: flicks,
  text: z.string().max(500),
  speaker: z.string().max(80).optional(),
  /** só presente quando há alinhamento real (provedor ou alinhador) */
  words: z.array(CaptionWord).optional(),
  /** clipe ao qual o segmento está vinculado (move/corta junto) */
  linkedClipId: id.optional(),
})
export type CaptionSegment = z.infer<typeof CaptionSegment>

export const CaptionStyle = z.object({
  id,
  name: z.string().max(80),
  fontFamily: z.enum(['Inter', 'Inter Display']),
  fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700), z.literal(800)]),
  fontSize: z.number().min(12).max(160),
  color: hexColor,
  highlightColor: hexColor,
  outlineColor: hexColor,
  outlineWidth: z.number().min(0).max(12),
  shadow: z.number().min(0).max(12),
  background: hexColor.nullable(),
  /** posição vertical do centro, fração da altura */
  positionY: z.number().min(0.05).max(0.95),
  /** margem lateral, fração da largura */
  marginX: z.number().min(0).max(0.4),
  uppercase: z.boolean(),
  highlightWords: z.boolean(),
})
export type CaptionStyle = z.infer<typeof CaptionStyle>

export const Marker = z.object({
  id,
  time: flicks,
  label: z.string().max(80),
  color: hexColor,
})
export type Marker = z.infer<typeof Marker>

export const Scene = z.object({
  key: z.string().min(1).max(64),
  title: z.string().max(200),
  narration: z.string().max(4000),
  visualPrompt: z.string().max(4000),
  estimatedDuration: flicks,
  characterIds: z.array(id).max(8),
  status: z.enum(['draft', 'approved']),
})
export type Scene = z.infer<typeof Scene>

export const TimelineDoc = z.object({
  schemaVersion: z.literal(DOC_SCHEMA_VERSION),
  settings: ProjectSettings,
  tracks: z.array(Track).max(64),
  captions: z.object({
    styleId: id,
    burnIn: z.boolean(),
    segments: z.array(CaptionSegment).max(20000),
  }),
  captionStyles: z.array(CaptionStyle).min(1).max(32),
  markers: z.array(Marker).max(500),
  scenes: z.array(Scene).max(500),
  safeArea: z.enum(['none', 'action', 'title', 'social']),
  meta: z.object({
    templateSlug: z.string().optional(),
    templateVersion: z.number().int().optional(),
    brandKitId: z.string().optional(),
  }),
})
export type TimelineDoc = z.infer<typeof TimelineDoc>

export const signedFlicksSchema = signedFlicks
