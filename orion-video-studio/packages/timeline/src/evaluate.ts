import type {
  AnyMediaClip,
  Clip,
  Easing,
  KeyframeProperty,
  TimelineDoc,
  Track,
} from '@orion/shared'
import { FLICKS_PER_SECOND } from './time.ts'

/**
 * Avaliação temporal do documento — compartilhada entre a prévia do navegador
 * e o gerador de filtros do FFmpeg. Toda animação é reduzida a SEGMENTOS
 * por partes (piecewise) com easing expressável em FFmpeg; a prévia avalia
 * os segmentos em JavaScript e a exportação converte os mesmos segmentos em
 * expressões. Assim a coerência prévia × exportação é garantida por
 * construção e verificada em teste.
 */

export type SegEasing = Easing | 'easeOut'

export interface Segment {
  /** segundos, relativos ao início do clipe */
  t0: number
  t1: number
  v0: number
  v1: number
  easing: SegEasing
}

/** Função por partes: antes do primeiro segmento vale `before`, depois `after`. */
export interface Piecewise {
  before: number
  after: number
  segments: Segment[]
}

export const constant = (v: number): Piecewise => ({ before: v, after: v, segments: [] })

export function ease(u: number, easing: SegEasing): number {
  const x = Math.min(1, Math.max(0, u))
  switch (easing) {
    case 'linear':
      return x
    case 'hold':
      return 0
    case 'easeInOut':
      return x * x * (3 - 2 * x)
    case 'easeOut':
      return 1 - (1 - x) * (1 - x)
  }
}

export function evalPiecewise(p: Piecewise, t: number): number {
  const segs = p.segments
  if (segs.length === 0) return p.before
  const first = segs[0]!
  if (t < first.t0) return p.before
  for (const s of segs) {
    if (t < s.t1) {
      if (t < s.t0) return s.v0
      const span = s.t1 - s.t0
      const u = span > 0 ? (t - s.t0) / span : 1
      return s.v0 + (s.v1 - s.v0) * ease(u, s.easing)
    }
  }
  return p.after
}

const sec = (f: number) => f / FLICKS_PER_SECOND

export function clipEnd(clip: { start: number; duration: number }): number {
  return clip.start + clip.duration
}

export function isMediaClip(c: Clip): c is AnyMediaClip {
  return c.type === 'video' || c.type === 'image' || c.type === 'audio'
}

export function isVisualClip(c: Clip): boolean {
  return c.type !== 'audio'
}

/** Tempo de mídia de origem consumido por um clipe. */
export function sourceSpan(clip: AnyMediaClip): number {
  return Math.round(clip.duration * clip.speed)
}

export function baseValue(clip: Clip, prop: KeyframeProperty): number {
  if (prop === 'volume') return isMediaClip(clip) ? clip.volume : 1
  return clip.transform[prop]
}

/** Keyframes do clipe convertidos em função por partes (valor absoluto). */
export function keyframePiecewise(clip: Clip, prop: KeyframeProperty): Piecewise {
  const kfs = clip.keyframes
    .filter((k) => k.property === prop)
    .sort((a, b) => a.time - b.time)
  if (kfs.length === 0) return constant(baseValue(clip, prop))
  if (kfs.length === 1) return constant(kfs[0]!.value)
  const segments: Segment[] = []
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!
    const b = kfs[i + 1]!
    if (b.time === a.time) continue
    segments.push({
      t0: sec(a.time),
      t1: sec(b.time),
      v0: a.value,
      v1: a.easing === 'hold' ? a.value : b.value,
      easing: a.easing === 'hold' ? 'linear' : a.easing,
    })
  }
  return { before: kfs[0]!.value, after: kfs[kfs.length - 1]!.value, segments }
}

const ANIM_IN = 0.35
const ANIM_OUT = 0.3

/** Contribuições multiplicativas/aditivas de animações predefinidas. */
export interface AnimationFactors {
  opacity: Piecewise[]
  scale: Piecewise[]
  dx: Piecewise[]
  dy: Piecewise[]
}

export function animationFactors(
  clip: Clip,
  opts: { dissolveDuration?: number } = {},
): AnimationFactors {
  const d = sec(clip.duration)
  const out: AnimationFactors = { opacity: [], scale: [], dx: [], dy: [] }
  const tin = clip.transitionIn
  if (tin && tin.duration > 0) {
    const td = Math.min(sec(tin.duration), d)
    out.opacity.push({
      before: 0,
      after: 1,
      segments: [{ t0: 0, t1: td, v0: 0, v1: 1, easing: 'linear' }],
    })
  } else if (opts.dissolveDuration) {
    // sem transição própria: nada a fazer
  }
  if (clip.type === 'text') {
    const ai = Math.min(ANIM_IN, d / 2)
    const ao = Math.min(ANIM_OUT, d / 2)
    switch (clip.animation) {
      case 'fade':
        out.opacity.push({
          before: 0,
          after: 0,
          segments: [
            { t0: 0, t1: ai, v0: 0, v1: 1, easing: 'linear' },
            { t0: ai, t1: d - ao, v0: 1, v1: 1, easing: 'linear' },
            { t0: d - ao, t1: d, v0: 1, v1: 0, easing: 'linear' },
          ],
        })
        break
      case 'slide-up':
        out.dy.push({
          before: 0.06,
          after: 0,
          segments: [{ t0: 0, t1: ai, v0: 0.06, v1: 0, easing: 'easeOut' }],
        })
        out.opacity.push({
          before: 0,
          after: 1,
          segments: [{ t0: 0, t1: ai, v0: 0, v1: 1, easing: 'linear' }],
        })
        break
      case 'pop':
        out.scale.push({
          before: 0.6,
          after: 1,
          segments: [{ t0: 0, t1: ai * 0.75, v0: 0.6, v1: 1, easing: 'easeOut' }],
        })
        out.opacity.push({
          before: 0,
          after: 1,
          segments: [{ t0: 0, t1: ai * 0.5, v0: 0, v1: 1, easing: 'linear' }],
        })
        break
      case 'none':
        break
    }
  }
  return out
}

export interface VisualState {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
}

/** Estado visual de um clipe no tempo local `t` (segundos desde o início). */
export function visualStateAt(clip: Clip, t: number): VisualState {
  const a = animationFactors(clip)
  let opacity = evalPiecewise(keyframePiecewise(clip, 'opacity'), t)
  for (const p of a.opacity) opacity *= evalPiecewise(p, t)
  let scale = evalPiecewise(keyframePiecewise(clip, 'scale'), t)
  for (const p of a.scale) scale *= evalPiecewise(p, t)
  let x = evalPiecewise(keyframePiecewise(clip, 'x'), t)
  for (const p of a.dx) x += evalPiecewise(p, t)
  let y = evalPiecewise(keyframePiecewise(clip, 'y'), t)
  for (const p of a.dy) y += evalPiecewise(p, t)
  const rotation = evalPiecewise(keyframePiecewise(clip, 'rotation'), t)
  return { x, y, scale, rotation, opacity: Math.min(1, Math.max(0, opacity)) }
}

/** Ganho de áudio no tempo local `t` (inclui fades). */
export function volumeAt(clip: AnyMediaClip, t: number, extendedBy = 0): number {
  let v = evalPiecewise(keyframePiecewise(clip, 'volume'), t)
  const d = sec(clip.duration + extendedBy)
  const fi = sec(clip.fadeIn)
  const fo = sec(clip.fadeOut)
  if (fi > 0 && t < fi) v *= t / fi
  if (fo > 0 && t > d - fo) v *= Math.max(0, (d - t) / fo)
  return v
}

/**
 * Extensão de renderização: quando o clipe seguinte tem `dissolve`, o clipe
 * anterior continua por baixo durante a transição (consumindo material
 * após o ponto de saída; se acabar, o último frame é mantido).
 */
export function dissolveExtensions(track: Track): Map<string, number> {
  const ext = new Map<string, number>()
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1]!
    const next = clips[i]!
    if (next.transitionIn?.type === 'dissolve' && clipEnd(prev) === next.start) {
      ext.set(prev.id, Math.min(next.transitionIn.duration, next.duration))
    }
  }
  return ext
}

export function docDuration(doc: TimelineDoc): number {
  let end = 0
  for (const t of doc.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c))
  return end
}

export const VISUAL_TRACK_KINDS = new Set(['video', 'overlay', 'text'])
export const AUDIO_TRACK_KINDS = new Set(['audio', 'voice', 'music'])

export interface ActiveLayer {
  track: Track
  clip: Clip
  /** segundos desde o início do clipe */
  localTime: number
  /** tempo na mídia de origem (flicks), só para clipes de mídia */
  sourceTime: number | null
  state: VisualState
}

/** Camadas visuais ativas em `t` (flicks), de baixo para cima. */
export function activeVisualLayers(
  doc: TimelineDoc,
  t: number,
  assetDurations: Record<string, number> = {},
): ActiveLayer[] {
  const layers: ActiveLayer[] = []
  for (const track of doc.tracks) {
    if (!VISUAL_TRACK_KINDS.has(track.kind) || track.hidden) continue
    const ext = dissolveExtensions(track)
    const clips = [...track.clips].sort((a, b) => a.start - b.start)
    for (const clip of clips) {
      if (!isVisualClip(clip)) continue
      const end = clipEnd(clip) + (ext.get(clip.id) ?? 0)
      if (t < clip.start || t >= end) continue
      const local = t - clip.start
      let sourceTime: number | null = null
      if (isMediaClip(clip)) {
        sourceTime = clip.sourceIn + Math.round(local * clip.speed)
        const total = assetDurations[clip.assetId]
        if (clip.type === 'video' && total !== undefined) {
          sourceTime = Math.min(sourceTime, Math.max(0, total - 1))
        }
      }
      // durante a extensão, o estado visual congela no último instante do clipe
      const stateT = Math.min(sec(local), sec(clip.duration))
      layers.push({
        track,
        clip,
        localTime: sec(local),
        sourceTime,
        state: visualStateAt(clip, stateT),
      })
    }
  }
  return layers
}

export function audibleTracks(doc: TimelineDoc): Track[] {
  const anySolo = doc.tracks.some((t) => t.solo)
  return doc.tracks.filter((t) => !t.muted && (!anySolo || t.solo))
}

/** Intervalos (flicks) com fala, usados para ducking na prévia e exportação. */
export function voiceIntervals(doc: TimelineDoc): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const track of audibleTracks(doc)) {
    if (track.kind !== 'voice') continue
    for (const c of track.clips) out.push([c.start, clipEnd(c)])
  }
  out.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const iv of out) {
    const last = merged[merged.length - 1]
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else merged.push([iv[0], iv[1]])
  }
  return merged
}
