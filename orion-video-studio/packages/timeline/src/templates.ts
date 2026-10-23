import type {
  Clip,
  ProjectSettings,
  TemplateDefinition,
  TextClip,
  TimelineDoc,
} from '@orion/shared'
import { DEFAULT_TRANSFORM, TemplateDefinition as TemplateSchema } from '@orion/shared'
import { produce } from 'immer'
import {
  applyZoom,
  createDocument,
  makeColorClip,
  makeMediaClip,
  makeTextClip,
  newId,
} from './ops.ts'
import { quantize, secondsToFlicks } from './time.ts'

export interface MediaFieldValue {
  assetId: string
  type: 'video' | 'image'
  durationFlicks: number | null
}

export interface ApplyTemplateInput {
  template: TemplateDefinition
  settings?: Partial<ProjectSettings>
  textValues?: Record<string, string>
  mediaValues?: Record<string, MediaFieldValue>
  /** duração alvo total (segundos); a cena flex absorve a diferença */
  targetSeconds?: number
}

/**
 * Constrói um documento a partir de um template. Campos de mídia ausentes
 * viram placeholders (clipe de cor com o nome do campo) que o usuário
 * substitui depois — nada é inventado.
 */
export function applyTemplate(input: ApplyTemplateInput): TimelineDoc {
  const template = TemplateSchema.parse(input.template)
  const aspect = input.settings?.aspect ?? template.aspects[0]!
  let doc = createDocument({ ...input.settings, aspect, background: template.colors.background })
  const fps = doc.settings.fps
  const q = (s: number) => quantize(secondsToFlicks(s), fps)

  // duração por cena com regra de flex
  const durations = template.scenes.map((s) => s.duration)
  const total = durations.reduce((a, b) => a + b, 0)
  if (input.targetSeconds && template.durationRules.flexSceneKey) {
    const target = Math.min(
      Math.max(input.targetSeconds, template.durationRules.minSeconds),
      template.durationRules.maxSeconds,
    )
    const fi = template.scenes.findIndex((s) => s.key === template.durationRules.flexSceneKey)
    if (fi >= 0) durations[fi] = Math.max(1, durations[fi]! + (target - total))
  }

  const trackIdByKind = (kind: 'video' | 'overlay' | 'text') => doc.tracks.find((t) => t.kind === kind)!.id
  const clips: Array<{ trackId: string; clip: Clip; zoom?: 'in' | 'out' | 'none' }> = []
  let cursor = 0
  template.scenes.forEach((scene, si) => {
    const sceneStart = cursor
    const sceneDur = q(durations[si]!)
    for (const el of scene.elements) {
      const start = sceneStart + q(el.offset)
      const end = el.duration === null ? sceneStart + sceneDur : Math.min(sceneStart + sceneDur, start + q(el.duration))
      if (end <= start) continue
      const duration = end - start
      let clip: Clip
      if (el.kind === 'media-slot') {
        const media = el.field ? input.mediaValues?.[el.field] : undefined
        if (media) {
          clip = makeMediaClip(media.type, media.assetId, start, duration, `${scene.title}`)
        } else {
          const label = template.fields.find((f) => f.key === el.field)?.label ?? 'Mídia'
          clip = { ...makeColorClip(template.colors.primary, start, duration), name: `Substituir: ${label}` }
        }
      } else if (el.kind === 'color') {
        clip = makeColorClip(el.color ?? template.colors.background, start, duration)
      } else {
        const fieldDefault = template.fields.find((f) => f.key === el.field)?.default
        const value = (el.field && input.textValues?.[el.field]) || el.text || fieldDefault || ' '
        const t = makeTextClip(value, start, duration) as TextClip
        t.field = el.field
        t.style = {
          ...t.style,
          fontFamily: template.fonts.heading,
          color: template.colors.text,
          ...el.style,
        }
        t.animation = el.animation ?? 'fade'
        t.transform = { ...DEFAULT_TRANSFORM, ...el.transform }
        clip = t
      }
      clip.sceneKey = scene.key
      if (el.transitionIn && sceneStart > 0 && el.offset === 0) {
        clip.transitionIn = { type: el.transitionIn, duration: Math.min(q(0.5), duration) }
      }
      if (el.kind !== 'text' && el.transform) clip.transform = { ...clip.transform, ...el.transform }
      const trackKind = el.kind === 'text' && el.track === 'video' ? 'text' : el.track
      clips.push({ trackId: trackIdByKind(trackKind), clip, zoom: el.zoom })
    }
    cursor += sceneDur
  })

  doc = produce(doc, (d) => {
    for (const { trackId, clip } of clips) {
      const track = d.tracks.find((t) => t.id === trackId)!
      // elementos sobrepostos na mesma trilha vão para uma trilha extra
      const clash = track.clips.some((c) => clip.start < c.start + c.duration && clip.start + clip.duration > c.start)
      if (clash) {
        let extra = d.tracks.find(
          (t) =>
            t.kind === track.kind &&
            t.id !== track.id &&
            !t.clips.some((c) => clip.start < c.start + c.duration && clip.start + clip.duration > c.start),
        )
        if (!extra) {
          extra = { ...track, id: newId(), name: `${track.name} 2`, clips: [] }
          d.tracks.splice(d.tracks.indexOf(track) + 1, 0, extra)
        }
        extra.clips.push(clip)
      } else {
        track.clips.push(clip)
      }
    }
    for (const t of d.tracks) t.clips.sort((a, b) => a.start - b.start)
    d.captionStyles = [{ id: 'template', name: `${template.name}`, ...template.captionStyle }]
    d.captions.styleId = 'template'
    const music = d.tracks.find((t) => t.kind === 'music')
    if (music) {
      music.volume = template.music.volume
      music.duckUnderVoice = template.music.duckUnderVoice
    }
    d.scenes = template.scenes.map((s, i) => ({
      key: s.key,
      title: s.title,
      narration: '',
      visualPrompt: s.narrationHint,
      estimatedDuration: q(durations[i]!),
      characterIds: [],
      status: 'draft' as const,
    }))
    d.meta = { templateSlug: template.slug, templateVersion: template.version }
  })
  for (const { clip, zoom } of clips) {
    if ((zoom === 'in' || zoom === 'out') && clip.type !== 'text') {
      doc = applyZoom(doc, clip.id, zoom, 0.08)
    }
  }
  return doc
}

/** Substitui o valor de um campo de texto em todos os clipes vinculados. */
export function setTemplateField(doc: TimelineDoc, field: string, value: string): TimelineDoc {
  return produce(doc, (d) => {
    for (const t of d.tracks)
      for (const c of t.clips) if (c.type === 'text' && c.field === field) c.text = value
  })
}

/** Extrai um template reutilizável a partir de um projeto (salvar como template). */
export function templateFromDocument(
  doc: TimelineDoc,
  meta: { slug: string; name: string; description: string },
): TemplateDefinition {
  const fps = doc.settings.fps
  const toSec = (f: number) => Math.round((f / 705_600_000) * 1000) / 1000
  const sceneBounds =
    doc.scenes.length > 0
      ? (() => {
          let t = 0
          return doc.scenes.map((s) => {
            const b = { key: s.key, title: s.title, start: t, end: t + s.estimatedDuration }
            t += s.estimatedDuration
            return b
          })
        })()
      : [{ key: 'cena1', title: 'Cena 1', start: 0, end: Math.max(...doc.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)), quantize(secondsToFlicks(5), fps)) }]
  const fields: TemplateDefinition['fields'] = []
  const scenes = sceneBounds.map((b) => {
    const elements: TemplateDefinition['scenes'][number]['elements'] = []
    for (const track of doc.tracks) {
      if (track.kind !== 'video' && track.kind !== 'overlay' && track.kind !== 'text') continue
      for (const c of track.clips) {
        if (c.start < b.start || c.start >= b.end) continue
        const offset = toSec(c.start - b.start)
        const duration = toSec(Math.min(c.duration, b.end - c.start))
        if (c.type === 'text') {
          const key = c.field ?? `texto_${fields.length + 1}`
          if (!fields.some((f) => f.key === key)) fields.push({ key, label: c.name || key, type: 'text', default: c.text })
          elements.push({ track: track.kind === 'video' ? 'text' : track.kind, kind: 'text', field: key, offset, duration, animation: c.animation, style: c.style, transform: c.transform })
        } else if (c.type === 'color') {
          elements.push({ track: track.kind === 'text' ? 'overlay' : track.kind, kind: 'color', color: c.color.slice(0, 7), offset, duration })
        } else if (c.type === 'video' || c.type === 'image') {
          const key = `midia_${fields.length + 1}`
          fields.push({ key, label: c.name || key, type: 'media', default: '' })
          elements.push({ track: track.kind === 'text' ? 'overlay' : track.kind, kind: 'media-slot', field: key, offset, duration })
        }
      }
    }
    return { key: b.key.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'cena', title: b.title, duration: Math.max(0.5, toSec(b.end - b.start)), narrationHint: '', elements: elements.slice(0, 20) }
  })
  const style = doc.captionStyles.find((s) => s.id === doc.captions.styleId) ?? doc.captionStyles[0]!
  const { id: _id, name: _name, ...captionStyle } = style
  const total = scenes.reduce((a, s) => a + s.duration, 0)
  return TemplateSchema.parse({
    schemaVersion: 1,
    slug: meta.slug,
    name: meta.name,
    category: 'personalizado',
    description: meta.description,
    version: 1,
    aspects: [doc.settings.aspect],
    colors: { background: doc.settings.background.slice(0, 7), primary: '#F2A93B', accent: '#6E8BFF', text: '#FFFFFF' },
    fonts: { heading: 'Inter Display', body: 'Inter' },
    captionStyle,
    durationRules: { minSeconds: Math.max(1, Math.floor(total / 2)), maxSeconds: Math.max(2, Math.ceil(total * 3)) },
    music: { mood: 'neutro', volume: doc.tracks.find((t) => t.kind === 'music')?.volume ?? 0.5, duckUnderVoice: true },
    fields,
    scenes,
    metadata: { author: 'Usuário', license: 'Privado', tags: [] },
  })
}
