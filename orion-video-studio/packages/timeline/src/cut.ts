import type { CaptionSegment, TimelineDoc } from '@orion/shared'
import { produce } from 'immer'
import { clipEnd, docDuration, isMediaClip } from './evaluate.ts'
import { EditError, splitClip } from './ops.ts'
import { FLICKS_PER_SECOND, frameDuration, quantize } from './time.ts'

/**
 * Cortes globais da timeline (edição pelo texto, remoção de pausas e cortes
 * curtos). Remover um intervalo [start, end) tira esse trecho de TODAS as
 * trilhas e puxa o restante para trás (ripple global), mantendo trilhas,
 * legendas e marcadores sincronizados entre si.
 */

export interface TimeRange {
  start: number
  end: number
}

/** Quantiza ao frame, descarta vazios e une intervalos sobrepostos ou encostados. */
export function normalizeRanges(doc: TimelineDoc, ranges: TimeRange[]): TimeRange[] {
  const fps = doc.settings.fps
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, quantize(r.start, fps)), end: Math.max(0, quantize(r.end, fps)) }))
    .filter((r) => r.end > r.start)
    .sort((x, y) => x.start - y.start)
  const out: TimeRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

export function rangesDuration(ranges: TimeRange[]): number {
  return ranges.reduce((s, r) => s + (r.end - r.start), 0)
}

/** Remove os intervalos de todas as trilhas, com ripple global. */
export function cutRanges(doc: TimelineDoc, ranges: TimeRange[]): TimelineDoc {
  const rs = normalizeRanges(doc, ranges)
  if (rs.length === 0) return doc
  const first = rs[0]!.start
  for (const t of doc.tracks) {
    if (t.locked && t.clips.some((c) => clipEnd(c) > first)) {
      throw new EditError(`A trilha "${t.name}" está bloqueada. Desbloqueie-a para cortar trechos da timeline.`, 'track_locked')
    }
  }
  let cur = doc
  // do fim para o início: cada corte não altera a posição dos anteriores
  for (const r of [...rs].reverse()) cur = cutOne(cur, r)
  return cur
}

function cutOne(doc: TimelineDoc, { start: a, end: b }: TimeRange): TimelineDoc {
  const fd = frameDuration(doc.settings.fps)
  let cur = doc
  for (const edge of [b, a]) {
    const crossing = cur.tracks.flatMap((t) => t.clips).filter((c) => c.start + fd <= edge && clipEnd(c) - fd >= edge)
    for (const c of crossing) cur = splitClip(cur, c.id, edge)
  }
  const len = b - a
  return produce(cur, (d) => {
    for (const track of d.tracks) {
      track.clips = track.clips.filter((c) => !(c.start >= a && clipEnd(c) <= b))
      for (const c of track.clips) {
        if (c.start >= b) {
          c.start -= len
        } else if (c.start < a && clipEnd(c) > a) {
          // sobra de menos de um frame que não pôde ser dividida: apara
          c.duration = Math.max(fd, a - c.start)
          c.keyframes = c.keyframes.filter((k) => k.time <= c.duration)
        } else if (c.start >= a && c.start < b) {
          const cut = b - c.start
          if (isMediaClip(c)) c.sourceIn += Math.round(cut * c.speed)
          c.duration = Math.max(fd, c.duration - cut)
          c.start = a
          for (const k of c.keyframes) k.time = Math.max(0, k.time - cut)
        }
      }
    }
    const segments: CaptionSegment[] = []
    for (const s of d.captions.segments) {
      if (s.end <= a) {
        segments.push(s)
        continue
      }
      if (s.start >= b) {
        segments.push(shiftSegment(s, -len))
        continue
      }
      const start = s.start < a ? s.start : a
      const end = s.end > b ? s.end - len : a
      if (end <= start) continue
      let words = s.words
      let text = s.text
      if (words) {
        words = words
          .filter((w) => w.end <= a || w.start >= b)
          .map((w) => (w.start >= b ? { ...w, start: w.start - len, end: w.end - len } : w))
        if (words.length === 0) continue
        text = words.map((w) => w.text).join(' ')
      }
      segments.push({ ...s, start, end, text, words })
    }
    // vínculo com clipe removido passa ao clipe que cobre o segmento (se houver)
    const clips = d.tracks.flatMap((t) => t.clips)
    const ids = new Set(clips.map((c) => c.id))
    for (const s of segments) {
      if (!s.linkedClipId || ids.has(s.linkedClipId)) continue
      const cover = clips.find((c) => isMediaClip(c) && c.type !== 'image' && c.start <= s.start && clipEnd(c) > s.start)
      s.linkedClipId = cover?.id
    }
    d.captions.segments = segments
    for (const m of d.markers) {
      if (m.time >= b) m.time -= len
      else if (m.time > a) m.time = a
    }
  })
}

function shiftSegment(s: CaptionSegment, delta: number): CaptionSegment {
  return {
    ...s,
    start: s.start + delta,
    end: s.end + delta,
    words: s.words?.map((w) => ({ ...w, start: w.start + delta, end: w.end + delta })),
  }
}

/** Mantém apenas [start, end) — base dos cortes curtos. Ignora bloqueios de trilha. */
export function extractRange(doc: TimelineDoc, start: number, end: number): TimelineDoc {
  const total = docDuration(doc)
  if (end <= start) throw new EditError('Intervalo vazio.', 'range_empty')
  const locks = doc.tracks.map((t) => t.locked)
  const unlocked = produce(doc, (d) => {
    for (const t of d.tracks) t.locked = false
  })
  const out = cutRanges(unlocked, [
    { start: 0, end: start },
    { start: end, end: Math.max(end, total) },
  ])
  return produce(out, (d) => {
    d.tracks.forEach((t, i) => {
      t.locked = locks[i] ?? false
    })
  })
}

// ---------------------------------------------------------------------------
// Edição pelo texto
// ---------------------------------------------------------------------------

/** Referência a uma palavra: índice do segmento e índice da palavra nele. */
export interface WordRef {
  segmentId: string
  index: number
}

/**
 * Converte palavras selecionadas em intervalos de corte. Cada sequência de
 * palavras consecutivas vira um corte do início da primeira até o início da
 * palavra seguinte (leva junto a pausa que vem depois), como em editores
 * baseados em texto. Só funciona com tempo por palavra real.
 */
export function wordSelectionRanges(segments: CaptionSegment[], selected: WordRef[]): TimeRange[] {
  const flat = segments.flatMap((s) => (s.words ?? []).map((w, index) => ({ w, key: `${s.id}:${index}`, seg: s })))
  const chosen = new Set(selected.map((r) => `${r.segmentId}:${r.index}`))
  const out: TimeRange[] = []
  let i = 0
  while (i < flat.length) {
    if (!chosen.has(flat[i]!.key)) {
      i++
      continue
    }
    let j = i
    while (j + 1 < flat.length && chosen.has(flat[j + 1]!.key)) j++
    const first = flat[i]!
    const last = flat[j]!
    const next = flat[j + 1]
    // dentro do mesmo segmento, vai até a próxima palavra; senão, até o fim da última
    const end = next && next.seg.id === last.seg.id ? next.w.start : last.w.end
    out.push({ start: first.w.start, end: Math.max(end, last.w.end) })
    i = j + 1
  }
  return out
}

/** Segmentos inteiros (para legendas sem tempo por palavra). */
export function segmentRanges(segments: CaptionSegment[], ids: string[]): TimeRange[] {
  const set = new Set(ids)
  return segments.filter((s) => set.has(s.id)).map((s) => ({ start: s.start, end: s.end }))
}

export const FILLER_WORDS = ['é', 'éé', 'ãh', 'ah', 'eh', 'hum', 'hmm', 'uhm', 'tipo', 'né', 'assim', 'então']

const normalizeWord = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFC')
    .replace(/[.,!?;:…"“”'()]/g, '')
    .trim()

/** Palavras de preenchimento ("ãh", "hum", "né"…). Só sugere; o usuário confirma. */
export function findFillerWords(segments: CaptionSegment[], fillers: string[] = FILLER_WORDS): WordRef[] {
  const set = new Set(fillers.map(normalizeWord))
  const out: WordRef[] = []
  for (const s of segments) {
    s.words?.forEach((w, index) => {
      if (set.has(normalizeWord(w.text))) out.push({ segmentId: s.id, index })
    })
  }
  return out
}

/**
 * Pausas longas entre falas. Usa o tempo por palavra quando existe; senão,
 * os intervalos entre segmentos. Mantém `pad` de respiro em cada lado.
 */
export function findPauses(doc: TimelineDoc, opts: { minGap?: number; pad?: number } = {}): TimeRange[] {
  const minGap = opts.minGap ?? Math.round(0.7 * FLICKS_PER_SECOND)
  const pad = opts.pad ?? Math.round(0.15 * FLICKS_PER_SECOND)
  const marks: Array<[number, number]> = []
  for (const s of doc.captions.segments) {
    if (s.words && s.words.length) for (const w of s.words) marks.push([w.start, w.end])
    else marks.push([s.start, s.end])
  }
  marks.sort((x, y) => x[0] - y[0])
  const out: TimeRange[] = []
  let lastEnd: number | null = null
  for (const [st, en] of marks) {
    if (lastEnd !== null && st - lastEnd >= minGap) {
      const r = { start: lastEnd + pad, end: st - pad }
      if (r.end > r.start) out.push(r)
    }
    lastEnd = lastEnd === null ? en : Math.max(lastEnd, en)
  }
  return normalizeRanges(doc, out)
}
