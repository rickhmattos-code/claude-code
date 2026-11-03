import type {
  CaptionSegment,
  Clip,
  Easing,
  KeyframeProperty,
  Marker,
  ProjectSettings,
  TimelineDoc,
  Track,
  TrackKind,
} from '@orion/shared'
import { DEFAULT_TRANSFORM, DOC_SCHEMA_VERSION } from '@orion/shared'
import { produce, type Draft } from 'immer'
import { clipEnd, isMediaClip, keyframePiecewise, evalPiecewise } from './evaluate.ts'
import { FLICKS_PER_SECOND, frameDuration, quantize } from './time.ts'

/**
 * Operações de edição puras e imutáveis. Cada operação recebe o documento e
 * devolve um novo documento (ou lança EditError com mensagem acionável).
 * O histórico de undo/redo guarda os documentos resultantes.
 */

export class EditError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
  }
}

export const newId = (): string => {
  const c = globalThis.crypto
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  // contextos não seguros (http fora de localhost) não expõem randomUUID
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const ASPECT_DIMENSIONS: Record<
  Exclude<ProjectSettings['aspect'], 'custom'>,
  { width: number; height: number }
> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
}

export const TRACK_ACCEPTS: Record<TrackKind, ReadonlyArray<Clip['type']>> = {
  video: ['video', 'image', 'color'],
  overlay: ['video', 'image', 'color', 'text'],
  text: ['text'],
  audio: ['audio'],
  voice: ['audio'],
  music: ['audio'],
}

export const TRACK_LABELS: Record<TrackKind, string> = {
  video: 'Vídeo',
  overlay: 'Sobreposição',
  text: 'Texto',
  audio: 'Áudio',
  voice: 'Narração',
  music: 'Música',
}

export function makeTrack(kind: TrackKind, name?: string): Track {
  return {
    id: newId(),
    kind,
    name: name ?? TRACK_LABELS[kind],
    muted: false,
    locked: false,
    hidden: false,
    solo: false,
    volume: kind === 'music' ? 0.6 : 1,
    duckUnderVoice: kind === 'music',
    clips: [],
  }
}

export function defaultCaptionStyle(id = 'padrao') {
  return {
    id,
    name: 'Padrão Orion',
    fontFamily: 'Inter' as const,
    fontWeight: 800 as const,
    fontSize: 64,
    color: '#FFFFFF',
    highlightColor: '#F2A93B',
    outlineColor: '#000000',
    outlineWidth: 4,
    shadow: 2,
    background: null,
    positionY: 0.78,
    marginX: 0.08,
    uppercase: false,
    highlightWords: true,
  }
}

export function createDocument(partial: Partial<ProjectSettings> = {}): TimelineDoc {
  const aspect = partial.aspect ?? '9:16'
  const dims =
    aspect === 'custom'
      ? { width: partial.width ?? 1080, height: partial.height ?? 1920 }
      : ASPECT_DIMENSIONS[aspect]
  const settings: ProjectSettings = {
    aspect,
    width: partial.width ?? dims.width,
    height: partial.height ?? dims.height,
    fps: partial.fps ?? { num: 30, den: 1 },
    sampleRate: 48000,
    background: partial.background ?? '#000000',
  }
  frameDuration(settings.fps) // valida fps
  return {
    schemaVersion: DOC_SCHEMA_VERSION,
    settings,
    // ordem de composição: índice 0 = camada inferior
    tracks: [
      makeTrack('video', 'Vídeo principal'),
      makeTrack('overlay'),
      makeTrack('text'),
      makeTrack('voice'),
      makeTrack('music'),
      makeTrack('audio', 'Efeitos sonoros'),
    ],
    captions: { styleId: 'padrao', burnIn: true, segments: [] },
    captionStyles: [defaultCaptionStyle()],
    markers: [],
    scenes: [],
    safeArea: 'social',
    meta: {},
  }
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export function findClip(doc: TimelineDoc, clipId: string) {
  for (const track of doc.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index >= 0) return { track, clip: track.clips[index]!, index }
  }
  return null
}

function requireClip(d: Draft<TimelineDoc>, clipId: string) {
  for (const track of d.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index >= 0) return { track, clip: track.clips[index]!, index }
  }
  throw new EditError('Clipe não encontrado.', 'clip_not_found')
}

function requireTrack(d: Draft<TimelineDoc>, trackId: string) {
  const t = d.tracks.find((x) => x.id === trackId)
  if (!t) throw new EditError('Trilha não encontrada.', 'track_not_found')
  return t
}

function assertEditable(track: Track | Draft<Track>) {
  if (track.locked) {
    throw new EditError(`A trilha "${track.name}" está bloqueada.`, 'track_locked')
  }
}

function overlaps(track: Track | Draft<Track>, start: number, end: number, ignore: Set<string>) {
  return track.clips.find((c) => !ignore.has(c.id) && start < clipEnd(c) && end > c.start)
}

function sortTrack(track: Draft<Track>) {
  track.clips.sort((a, b) => a.start - b.start)
}

const q = (doc: TimelineDoc, t: number) => quantize(t, doc.settings.fps)

// ---------------------------------------------------------------------------
// Clipes
// ---------------------------------------------------------------------------

export type InsertMode = 'free' | 'insert'

export function addClip(
  doc: TimelineDoc,
  trackId: string,
  clip: Clip,
  mode: InsertMode = 'free',
): TimelineDoc {
  return produce(doc, (d) => {
    const track = requireTrack(d, trackId)
    assertEditable(track)
    if (!TRACK_ACCEPTS[track.kind].includes(clip.type)) {
      throw new EditError(
        `Clipes do tipo "${clip.type}" não podem ir para a trilha ${TRACK_LABELS[track.kind]}.`,
        'track_kind_mismatch',
      )
    }
    const c = { ...clip, start: q(doc, clip.start), duration: Math.max(frameDuration(doc.settings.fps), q(doc, clip.duration)) }
    if (mode === 'insert') {
      for (const other of track.clips) if (other.start >= c.start) other.start += c.duration
      const split = track.clips.find((o) => o.start < c.start && clipEnd(o) > c.start)
      if (split) {
        throw new EditError('Posicione o cursor fora de um clipe para inserir.', 'insert_inside_clip')
      }
    } else if (overlaps(track, c.start, clipEnd(c), new Set())) {
      throw new EditError('Já existe um clipe nesse intervalo da trilha.', 'overlap')
    }
    track.clips.push(c as Draft<Clip>)
    sortTrack(track)
  })
}

/** Primeiro tempo livre ≥ `from` na trilha capaz de comportar `duration`. */
export function findFreeSlot(track: Track, from: number, duration: number): number {
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  let t = from
  for (const c of clips) {
    if (clipEnd(c) <= t) continue
    if (c.start >= t + duration) break
    t = Math.max(t, clipEnd(c))
  }
  return t
}

export function moveClip(
  doc: TimelineDoc,
  clipId: string,
  toTrackId: string,
  newStart: number,
): TimelineDoc {
  return produce(doc, (d) => {
    const src = requireClip(d, clipId)
    const target = requireTrack(d, toTrackId)
    assertEditable(src.track)
    assertEditable(target)
    if (!TRACK_ACCEPTS[target.kind].includes(src.clip.type)) {
      throw new EditError('Tipo de clipe incompatível com a trilha de destino.', 'track_kind_mismatch')
    }
    const start = Math.max(0, q(doc, newStart))
    if (overlaps(target, start, start + src.clip.duration, new Set([clipId]))) {
      throw new EditError('O destino se sobrepõe a outro clipe.', 'overlap')
    }
    const delta = start - src.clip.start
    const moved = src.track.clips.splice(src.index, 1)[0]!
    moved.start = start
    target.clips.push(moved)
    sortTrack(target)
    shiftLinkedCaptions(d, clipId, delta)
  })
}

export function trimClip(
  doc: TimelineDoc,
  clipId: string,
  edge: 'start' | 'end',
  time: number,
  sourceDuration?: number,
): TimelineDoc {
  return produce(doc, (d) => {
    const { track, clip } = requireClip(d, clipId)
    assertEditable(track)
    const fd = frameDuration(doc.settings.fps)
    const t = q(doc, time)
    const end = clipEnd(clip)
    if (edge === 'start') {
      let newStart = Math.min(t, end - fd)
      if (isMediaClip(clip) && clip.type !== 'image') {
        // não pode começar antes do início da mídia
        const minStart = clip.start - Math.floor(clip.sourceIn / clip.speed)
        newStart = Math.max(newStart, q(doc, Math.max(0, minStart)))
      }
      newStart = Math.max(0, newStart)
      const prev = track.clips.filter((c) => c.id !== clip.id && clipEnd(c) <= clip.start)
      const limit = prev.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
      newStart = Math.max(newStart, limit)
      const delta = newStart - clip.start
      if (isMediaClip(clip)) clip.sourceIn = Math.max(0, clip.sourceIn + Math.round(delta * clip.speed))
      clip.start = newStart
      clip.duration = end - newStart
      for (const k of clip.keyframes) k.time -= delta
      clip.keyframes = clip.keyframes.filter((k) => k.time >= 0 && k.time <= clip.duration)
    } else {
      let newEnd = Math.max(t, clip.start + fd)
      if (isMediaClip(clip) && clip.type !== 'image' && sourceDuration !== undefined) {
        const maxEnd = clip.start + Math.floor((sourceDuration - clip.sourceIn) / clip.speed)
        newEnd = Math.min(newEnd, quantize(maxEnd, doc.settings.fps, 'floor'))
      }
      const next = track.clips.filter((c) => c.id !== clip.id && c.start >= end)
      const limit = next.reduce((m, c) => Math.min(m, c.start), Number.MAX_SAFE_INTEGER)
      newEnd = Math.min(newEnd, limit)
      clip.duration = newEnd - clip.start
      clip.keyframes = clip.keyframes.filter((k) => k.time <= clip.duration)
    }
    trimLinkedCaptions(d, clip.id, clip.start, clipEnd(clip))
  })
}

export function splitClip(doc: TimelineDoc, clipId: string, at: number): TimelineDoc {
  return produce(doc, (d) => {
    const { track, clip } = requireClip(d, clipId)
    assertEditable(track)
    const t = q(doc, at)
    const fd = frameDuration(doc.settings.fps)
    if (t < clip.start + fd || t > clipEnd(clip) - fd) {
      throw new EditError('Posicione o cursor dentro do clipe para dividir.', 'split_outside')
    }
    const firstDur = t - clip.start
    const right = JSON.parse(JSON.stringify(clip)) as Draft<Clip>
    right.id = newId()
    right.start = t
    right.duration = clip.duration - firstDur
    right.transitionIn = undefined
    if (isMediaClip(right) && isMediaClip(clip)) {
      right.sourceIn = clip.sourceIn + Math.round(firstDur * clip.speed)
      right.fadeIn = 0
      clip.fadeOut = 0
    }
    // keyframes: particiona e cria valores de borda para manter a curva
    const props = new Set(clip.keyframes.map((k) => k.property))
    const leftKfs: typeof clip.keyframes = []
    const rightKfs: typeof clip.keyframes = []
    for (const prop of props) {
      const pw = keyframePiecewise(clip as Clip, prop)
      const v = evalPiecewise(pw, firstDur / FLICKS_PER_SECOND)
      const kfs = clip.keyframes.filter((k) => k.property === prop)
      leftKfs.push(...kfs.filter((k) => k.time < firstDur))
      leftKfs.push({ id: newId(), property: prop, time: firstDur, value: v, easing: 'linear' })
      rightKfs.push({ id: newId(), property: prop, time: 0, value: v, easing: 'linear' })
      rightKfs.push(
        ...kfs.filter((k) => k.time > firstDur).map((k) => ({ ...k, id: newId(), time: k.time - firstDur })),
      )
    }
    clip.keyframes = leftKfs
    right.keyframes = rightKfs
    clip.duration = firstDur
    track.clips.push(right)
    sortTrack(track)
    for (const s of d.captions.segments) {
      if (s.linkedClipId === clip.id && s.start >= t) s.linkedClipId = right.id
    }
  })
}

export function duplicateClip(doc: TimelineDoc, clipId: string): { doc: TimelineDoc; newClipId: string } {
  const found = findClip(doc, clipId)
  if (!found) throw new EditError('Clipe não encontrado.', 'clip_not_found')
  const copy = JSON.parse(JSON.stringify(found.clip)) as Clip
  copy.id = newId()
  copy.keyframes = copy.keyframes.map((k) => ({ ...k, id: newId() }))
  copy.effects = copy.effects.map((e) => ({ ...e, id: newId() }))
  copy.start = findFreeSlot(found.track, clipEnd(found.clip), copy.duration)
  return { doc: addClip(doc, found.track.id, copy), newClipId: copy.id }
}

/**
 * Exclui clipes. Com `ripple`, os clipes seguintes da MESMA trilha recuam
 * para fechar o espaço (e legendas vinculadas acompanham).
 */
export function deleteClips(doc: TimelineDoc, clipIds: string[], ripple = false): TimelineDoc {
  return produce(doc, (d) => {
    const ids = new Set(clipIds)
    for (const track of d.tracks) {
      const removed = track.clips.filter((c) => ids.has(c.id))
      if (removed.length === 0) continue
      assertEditable(track)
      track.clips = track.clips.filter((c) => !ids.has(c.id))
      if (ripple) {
        // processa do fim para o início para deslocamentos corretos
        for (const r of [...removed].sort((a, b) => b.start - a.start)) {
          const gap = r.duration
          for (const c of track.clips) {
            if (c.start >= clipEnd(r)) {
              c.start -= gap
              shiftLinkedCaptions(d, c.id, -gap)
            }
          }
        }
      }
    }
    d.captions.segments = d.captions.segments.filter((s) => !s.linkedClipId || !ids.has(s.linkedClipId))
  })
}

export function setClipSpeed(doc: TimelineDoc, clipId: string, speed: number): TimelineDoc {
  return produce(doc, (d) => {
    const { track, clip } = requireClip(d, clipId)
    assertEditable(track)
    if (!isMediaClip(clip) || clip.type === 'image') {
      throw new EditError('Velocidade só se aplica a vídeo e áudio.', 'speed_unsupported')
    }
    if (speed < 0.25 || speed > 4) throw new EditError('Velocidade entre 0,25× e 4×.', 'speed_range')
    const span = Math.round(clip.duration * clip.speed)
    const newDur = Math.max(frameDuration(doc.settings.fps), q(doc, Math.round(span / speed)))
    if (overlaps(track, clip.start, clip.start + newDur, new Set([clip.id]))) {
      throw new EditError('Sem espaço na trilha para a nova duração. Afaste o próximo clipe.', 'overlap')
    }
    const ratio = newDur / clip.duration
    for (const k of clip.keyframes) k.time = Math.round(k.time * ratio)
    clip.speed = speed
    clip.duration = newDur
  })
}

export function updateClip(doc: TimelineDoc, clipId: string, recipe: (clip: Draft<Clip>) => void): TimelineDoc {
  return produce(doc, (d) => {
    const { track, clip } = requireClip(d, clipId)
    assertEditable(track)
    recipe(clip)
  })
}

export function replaceClipAsset(
  doc: TimelineDoc,
  clipId: string,
  assetId: string,
  assetDuration: number | null,
): TimelineDoc {
  return produce(doc, (d) => {
    const { clip } = requireClip(d, clipId)
    if (!isMediaClip(clip)) throw new EditError('Somente clipes de mídia.', 'not_media')
    clip.assetId = assetId
    clip.sourceIn = 0
    if (assetDuration !== null && clip.type !== 'image') {
      const maxDur = quantize(Math.floor(assetDuration / clip.speed), doc.settings.fps, 'floor')
      if (maxDur < clip.duration) clip.duration = Math.max(frameDuration(doc.settings.fps), maxDur)
    }
  })
}

/**
 * Substitui o áudio de uma frase de narração.
 *  - 'preserve': mantém o espaço original; se ficar maior, acelera até 1,25×
 *    (atempo preserva o tom); acima disso, corta e avisa.
 *  - 'shift': o clipe assume a nova duração e todos os elementos posteriores
 *    (todas as trilhas, legendas e marcadores) são deslocados.
 */
export function replaceSentenceAudio(
  doc: TimelineDoc,
  clipId: string,
  assetId: string,
  newDuration: number,
  mode: 'preserve' | 'shift',
): { doc: TimelineDoc; warning: string | null } {
  let warning: string | null = null
  const next = produce(doc, (d) => {
    const { clip } = requireClip(d, clipId)
    if (clip.type !== 'audio') throw new EditError('Selecione um clipe de narração.', 'not_audio')
    const oldEnd = clipEnd(clip)
    const fd = frameDuration(doc.settings.fps)
    clip.assetId = assetId
    clip.sourceIn = 0
    clip.keyframes = []
    if (mode === 'preserve') {
      const slot = clip.duration
      if (newDuration <= slot) {
        clip.speed = 1
        clip.duration = Math.max(fd, quantize(newDuration, doc.settings.fps, 'floor'))
      } else {
        const ratio = newDuration / slot
        if (ratio <= 1.25) {
          clip.speed = Math.round(ratio * 1000) / 1000
          clip.duration = slot
        } else {
          clip.speed = 1.25
          clip.duration = slot
          warning = 'A nova frase é muito mais longa que o espaço original; o final foi cortado. Use "deslocar" para manter a frase inteira.'
        }
      }
    } else {
      clip.speed = 1
      const newDur = Math.max(fd, quantize(newDuration, doc.settings.fps, 'ceil'))
      const delta = newDur - clip.duration
      clip.duration = newDur
      if (delta !== 0) {
        for (const track of d.tracks) {
          for (const c of track.clips) if (c.id !== clip.id && c.start >= oldEnd) c.start += delta
        }
        for (const s of d.captions.segments) {
          if (s.start >= oldEnd) {
            s.start += delta
            s.end += delta
          }
        }
        for (const m of d.markers) if (m.time >= oldEnd) m.time += delta
      }
    }
  })
  return { doc: next, warning }
}

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

export function setKeyframe(
  doc: TimelineDoc,
  clipId: string,
  property: KeyframeProperty,
  time: number,
  value: number,
  easing: Easing = 'linear',
): TimelineDoc {
  return produce(doc, (d) => {
    const { track, clip } = requireClip(d, clipId)
    assertEditable(track)
    const t = Math.min(Math.max(0, q(doc, time)), clip.duration)
    const existing = clip.keyframes.find((k) => k.property === property && k.time === t)
    if (existing) {
      existing.value = value
      existing.easing = easing
    } else {
      clip.keyframes.push({ id: newId(), property, time: t, value, easing })
    }
    clip.keyframes.sort((a, b) => a.time - b.time)
  })
}

export function removeKeyframe(doc: TimelineDoc, clipId: string, keyframeId: string): TimelineDoc {
  return updateClip(doc, clipId, (clip) => {
    clip.keyframes = clip.keyframes.filter((k) => k.id !== keyframeId)
  })
}

/** Zoom/pan "Ken Burns": keyframes de escala (e opcionalmente posição). */
export function applyZoom(doc: TimelineDoc, clipId: string, direction: 'in' | 'out', amount = 0.12): TimelineDoc {
  const found = findClip(doc, clipId)
  if (!found) throw new EditError('Clipe não encontrado.', 'clip_not_found')
  const base = found.clip.transform.scale
  const from = direction === 'in' ? base : base * (1 + amount)
  const to = direction === 'in' ? base * (1 + amount) : base
  const cleared = updateClip(doc, clipId, (c) => {
    c.keyframes = c.keyframes.filter((k) => k.property !== 'scale')
  })
  const a = setKeyframe(cleared, clipId, 'scale', 0, from, 'linear')
  return setKeyframe(a, clipId, 'scale', found.clip.duration, to, 'linear')
}

// ---------------------------------------------------------------------------
// Trilhas
// ---------------------------------------------------------------------------

export function addTrack(doc: TimelineDoc, kind: TrackKind, index?: number): TimelineDoc {
  return produce(doc, (d) => {
    if (d.tracks.length >= 64) throw new EditError('Limite de 64 trilhas.', 'track_limit')
    const t = makeTrack(kind, `${TRACK_LABELS[kind]} ${d.tracks.filter((x) => x.kind === kind).length + 1}`)
    d.tracks.splice(index ?? d.tracks.length, 0, t)
  })
}

export function removeTrack(doc: TimelineDoc, trackId: string): TimelineDoc {
  return produce(doc, (d) => {
    const t = requireTrack(d, trackId)
    assertEditable(t)
    const ids = new Set(t.clips.map((c) => c.id))
    d.tracks = d.tracks.filter((x) => x.id !== trackId)
    d.captions.segments = d.captions.segments.filter((s) => !s.linkedClipId || !ids.has(s.linkedClipId))
  })
}

export function moveTrack(doc: TimelineDoc, trackId: string, newIndex: number): TimelineDoc {
  return produce(doc, (d) => {
    const i = d.tracks.findIndex((t) => t.id === trackId)
    if (i < 0) throw new EditError('Trilha não encontrada.', 'track_not_found')
    const [t] = d.tracks.splice(i, 1)
    d.tracks.splice(Math.max(0, Math.min(newIndex, d.tracks.length)), 0, t!)
  })
}

export function setTrackFlags(
  doc: TimelineDoc,
  trackId: string,
  patch: Partial<Pick<Track, 'muted' | 'locked' | 'hidden' | 'solo' | 'volume' | 'name' | 'duckUnderVoice'>>,
): TimelineDoc {
  return produce(doc, (d) => {
    Object.assign(requireTrack(d, trackId), patch)
  })
}

// ---------------------------------------------------------------------------
// Marcadores
// ---------------------------------------------------------------------------

export function addMarker(doc: TimelineDoc, time: number, label = 'Marcador', color = '#F2A93B'): TimelineDoc {
  return produce(doc, (d) => {
    const m: Marker = { id: newId(), time: q(doc, time), label, color }
    d.markers.push(m)
    d.markers.sort((a, b) => a.time - b.time)
  })
}

export function removeMarker(doc: TimelineDoc, markerId: string): TimelineDoc {
  return produce(doc, (d) => {
    d.markers = d.markers.filter((m) => m.id !== markerId)
  })
}

// ---------------------------------------------------------------------------
// Legendas
// ---------------------------------------------------------------------------

function shiftLinkedCaptions(d: Draft<TimelineDoc>, clipId: string, delta: number) {
  if (delta === 0) return
  for (const s of d.captions.segments) {
    if (s.linkedClipId !== clipId) continue
    s.start = Math.max(0, s.start + delta)
    s.end = Math.max(s.start + 1, s.end + delta)
    if (s.words) for (const w of s.words) {
      w.start = Math.max(0, w.start + delta)
      w.end = Math.max(0, w.end + delta)
    }
  }
  d.captions.segments.sort((a, b) => a.start - b.start)
}

/** Segmentos vinculados fora do novo intervalo são removidos; os que cruzam a borda são recortados. */
function trimLinkedCaptions(d: Draft<TimelineDoc>, clipId: string, start: number, end: number) {
  d.captions.segments = d.captions.segments.filter((s) => {
    if (s.linkedClipId !== clipId) return true
    if (s.end <= start || s.start >= end) return false
    s.start = Math.max(s.start, start)
    s.end = Math.min(s.end, end)
    if (s.words) s.words = s.words.filter((w) => w.end > s.start && w.start < s.end)
    return true
  })
}

export function addCaption(doc: TimelineDoc, seg: Omit<CaptionSegment, 'id'> & { id?: string }): TimelineDoc {
  if (seg.end <= seg.start) throw new EditError('O fim da legenda deve ser após o início.', 'caption_range')
  return produce(doc, (d) => {
    d.captions.segments.push({ ...seg, id: seg.id ?? newId() })
    d.captions.segments.sort((a, b) => a.start - b.start)
  })
}

export function updateCaption(
  doc: TimelineDoc,
  id: string,
  patch: Partial<Pick<CaptionSegment, 'text' | 'start' | 'end' | 'speaker'>>,
): TimelineDoc {
  return produce(doc, (d) => {
    const s = d.captions.segments.find((x) => x.id === id)
    if (!s) throw new EditError('Legenda não encontrada.', 'caption_not_found')
    const start = patch.start ?? s.start
    const end = patch.end ?? s.end
    if (end <= start) throw new EditError('O fim da legenda deve ser após o início.', 'caption_range')
    if (patch.text !== undefined && patch.text !== s.text) s.words = undefined // alinhamento deixa de valer
    Object.assign(s, patch)
    if (s.words) s.words = s.words.filter((w) => w.end > s.start && w.start < s.end)
    d.captions.segments.sort((a, b) => a.start - b.start)
  })
}

export function removeCaption(doc: TimelineDoc, id: string): TimelineDoc {
  return produce(doc, (d) => {
    d.captions.segments = d.captions.segments.filter((s) => s.id !== id)
  })
}

/** Divide o segmento no tempo `at`; o texto é dividido pela palavra mais próxima. */
export function splitCaption(doc: TimelineDoc, id: string, at: number): TimelineDoc {
  return produce(doc, (d) => {
    const i = d.captions.segments.findIndex((x) => x.id === id)
    const s = d.captions.segments[i]
    if (!s) throw new EditError('Legenda não encontrada.', 'caption_not_found')
    if (at <= s.start || at >= s.end) throw new EditError('Posicione o cursor dentro da legenda.', 'split_outside')
    let leftText: string
    let rightText: string
    let leftWords = s.words?.filter((w) => w.end <= at)
    let rightWords = s.words?.filter((w) => w.end > at)
    if (s.words && s.words.length > 0 && leftWords && rightWords && leftWords.length && rightWords.length) {
      leftText = leftWords.map((w) => w.text).join(' ')
      rightText = rightWords.map((w) => w.text).join(' ')
    } else {
      const words = s.text.split(/\s+/).filter(Boolean)
      const ratio = (at - s.start) / (s.end - s.start)
      const cut = Math.min(words.length - 1, Math.max(1, Math.round(words.length * ratio)))
      leftText = words.slice(0, cut).join(' ')
      rightText = words.slice(cut).join(' ')
      leftWords = undefined
      rightWords = undefined
    }
    const right: CaptionSegment = { ...s, id: newId(), start: at, text: rightText || s.text, words: rightWords }
    s.end = at
    s.text = leftText || s.text
    s.words = leftWords
    d.captions.segments.splice(i + 1, 0, right as Draft<CaptionSegment>)
  })
}

export function mergeCaptions(doc: TimelineDoc, firstId: string, secondId: string): TimelineDoc {
  return produce(doc, (d) => {
    const a = d.captions.segments.find((x) => x.id === firstId)
    const b = d.captions.segments.find((x) => x.id === secondId)
    if (!a || !b) throw new EditError('Legenda não encontrada.', 'caption_not_found')
    const [first, second] = a.start <= b.start ? [a, b] : [b, a]
    first.end = Math.max(first.end, second.end)
    first.text = `${first.text} ${second.text}`.trim()
    first.words = first.words && second.words ? [...first.words, ...second.words] : undefined
    d.captions.segments = d.captions.segments.filter((x) => x.id !== second.id)
  })
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

export function snapCandidates(doc: TimelineDoc, opts: { exclude?: Set<string>; playhead?: number } = {}): number[] {
  const set = new Set<number>([0])
  for (const t of doc.tracks)
    for (const c of t.clips) {
      if (opts.exclude?.has(c.id)) continue
      set.add(c.start)
      set.add(clipEnd(c))
    }
  for (const m of doc.markers) set.add(m.time)
  if (opts.playhead !== undefined) set.add(opts.playhead)
  return [...set].sort((a, b) => a - b)
}

export function snapTime(time: number, candidates: number[], threshold: number): { time: number; snapped: boolean } {
  let best = time
  let bestDist = threshold + 1
  for (const c of candidates) {
    const dist = Math.abs(c - time)
    if (dist < bestDist) {
      best = c
      bestDist = dist
    }
  }
  return bestDist <= threshold ? { time: best, snapped: true } : { time, snapped: false }
}

// ---------------------------------------------------------------------------
// Fábricas de clipes
// ---------------------------------------------------------------------------

export function makeMediaClip(
  type: 'video' | 'image' | 'audio',
  assetId: string,
  start: number,
  duration: number,
  name: string,
): Clip {
  return {
    id: newId(),
    type,
    name,
    assetId,
    start,
    duration,
    sourceIn: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    transform: { ...DEFAULT_TRANSFORM },
    fit: 'cover',
    keyframes: [],
    effects: [],
  } as Clip
}

export function makeTextClip(text: string, start: number, duration: number): Clip {
  return {
    id: newId(),
    type: 'text',
    name: text.slice(0, 40),
    text,
    start,
    duration,
    style: {
      fontFamily: 'Inter',
      fontWeight: 800,
      fontSize: 80,
      color: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 3,
      shadow: 2,
      background: null,
      align: 'center',
    },
    animation: 'fade',
    transform: { ...DEFAULT_TRANSFORM, y: 0.4 },
    fit: 'contain',
    keyframes: [],
    effects: [],
  }
}

export function makeColorClip(color: string, start: number, duration: number): Clip {
  return {
    id: newId(),
    type: 'color',
    name: 'Cor sólida',
    color,
    start,
    duration,
    transform: { ...DEFAULT_TRANSFORM },
    fit: 'cover',
    keyframes: [],
    effects: [],
  }
}
