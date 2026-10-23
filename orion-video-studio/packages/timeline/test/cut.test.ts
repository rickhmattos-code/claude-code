import type { AnyMediaClip, TimelineDoc } from '@orion/shared'
import { describe, expect, test } from 'vitest'
import {
  addCaption,
  addClip,
  addMarker,
  createDocument,
  cutRanges,
  docDuration,
  energyCurve,
  extractRange,
  findFillerWords,
  findPauses,
  formatClock,
  makeMediaClip,
  makeTextClip,
  normalizeRanges,
  secondsToFlicks,
  setKeyframe,
  setTrackFlags,
  suggestHighlights,
  validateDoc,
  visualStateAt,
  wordSelectionRanges,
} from '../src/index.ts'

const S = (s: number) => secondsToFlicks(s)

/** vídeo 0–20 s, música 0–20 s, título 4–8 s, legenda com palavras 2–6 s */
function sample() {
  let doc = createDocument({ aspect: '16:9' })
  const video = makeMediaClip('video', 'v1', 0, S(20), 'V')
  const music = makeMediaClip('audio', 'm1', 0, S(20), 'M')
  const title = makeTextClip('Título', S(4), S(4))
  doc = addClip(doc, doc.tracks[0]!.id, video)
  doc = addClip(doc, doc.tracks.find((t) => t.kind === 'music')!.id, music)
  doc = addClip(doc, doc.tracks.find((t) => t.kind === 'text')!.id, title)
  doc = addCaption(doc, {
    start: S(2),
    end: S(6),
    text: 'olá ãh mundo bonito',
    linkedClipId: video.id,
    words: [
      { text: 'olá', start: S(2), end: S(2.5) },
      { text: 'ãh', start: S(3), end: S(3.4) },
      { text: 'mundo', start: S(4), end: S(4.6) },
      { text: 'bonito', start: S(5), end: S(6) },
    ],
  })
  doc = addCaption(doc, { start: S(12), end: S(14), text: 'segunda frase', linkedClipId: video.id })
  doc = addMarker(doc, S(15), 'fim')
  return { doc, video, music, title }
}

const clipsOf = (doc: TimelineDoc, kind: string) => doc.tracks.find((t) => t.kind === kind)!.clips as AnyMediaClip[]

describe('global cuts (edit by text)', () => {
  test('cutting a range ripples every track, keeps source continuity and shortens the timeline', () => {
    const { doc } = sample()
    const out = cutRanges(doc, [{ start: S(3), end: S(4) }])
    expect(docDuration(out)).toBe(S(19))
    const v = clipsOf(out, 'video')
    expect(v.map((c) => [c.start, c.duration, c.sourceIn])).toEqual([
      [0, S(3), 0],
      [S(3), S(16), S(4)],
    ])
    const m = clipsOf(out, 'music')
    expect(m.map((c) => [c.start, c.sourceIn])).toEqual([
      [0, 0],
      [S(3), S(4)],
    ])
    // título 4–8 começa exatamente no corte → recua para 3–7
    const t = out.tracks.find((x) => x.kind === 'text')!.clips
    expect(t.map((c) => [c.start, c.duration])).toEqual([[S(3), S(4)]])
    expect(out.markers[0]!.time).toBe(S(14))
    expect(validateDoc(out).issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  test('captions lose the deleted words, later words shift and text is rebuilt', () => {
    const { doc } = sample()
    const ranges = wordSelectionRanges(doc.captions.segments, findFillerWords(doc.captions.segments))
    // "ãh" vai do início dele até o início da próxima palavra
    expect(ranges).toEqual([{ start: S(3), end: S(4) }])
    const out = cutRanges(doc, ranges)
    const [first, second] = out.captions.segments
    expect(first!.text).toBe('olá mundo bonito')
    expect(first!.words!.map((w) => [w.text, w.start])).toEqual([
      ['olá', S(2)],
      ['mundo', S(3)],
      ['bonito', S(4)],
    ])
    expect([first!.start, first!.end]).toEqual([S(2), S(5)])
    expect([second!.start, second!.end]).toEqual([S(11), S(13)])
    // vínculo mantido com um clipe existente
    const ids = new Set(out.tracks.flatMap((t) => t.clips.map((c) => c.id)))
    for (const s of out.captions.segments) expect(ids.has(s.linkedClipId!)).toBe(true)
  })

  test('a segment entirely inside the cut is removed; multiple ranges compose correctly', () => {
    const { doc } = sample()
    const out = cutRanges(doc, [
      { start: S(11), end: S(15) },
      { start: S(0), end: S(1) },
    ])
    expect(docDuration(out)).toBe(S(15))
    expect(out.captions.segments.map((s) => s.text)).toEqual(['olá ãh mundo bonito'])
    expect(out.captions.segments[0]!.start).toBe(S(1))
    expect(out.markers[0]!.time).toBe(S(10)) // estava dentro do corte → vai para o ponto do corte
  })

  test('keyframed values are continuous across the cut', () => {
    let { doc, video } = sample()
    doc = setKeyframe(doc, video.id, 'scale', 0, 1)
    doc = setKeyframe(doc, video.id, 'scale', S(20), 2)
    const out = cutRanges(doc, [{ start: S(5), end: S(10) }])
    const [left, right] = clipsOf(out, 'video')
    const original = clipsOf(doc, 'video')[0]!
    // cada lado mantém a curva original nos seus trechos
    // (visualStateAt usa segundos locais)
    expect(visualStateAt(left!, 4).scale).toBeCloseTo(visualStateAt(original, 4).scale, 6)
    expect(visualStateAt(right!, 0).scale).toBeCloseTo(visualStateAt(original, 10).scale, 6)
    expect(visualStateAt(right!, 5).scale).toBeCloseTo(visualStateAt(original, 15).scale, 6)
  })

  test('locked tracks block the cut; normalize merges overlapping ranges', () => {
    const { doc } = sample()
    const locked = setTrackFlags(doc, doc.tracks[0]!.id, { locked: true })
    expect(() => cutRanges(locked, [{ start: S(1), end: S(2) }])).toThrow(/bloqueada/)
    expect(normalizeRanges(doc, [
      { start: S(2), end: S(3) },
      { start: S(1), end: S(2.5) },
      { start: S(5), end: S(5) },
    ])).toEqual([{ start: S(1), end: S(3) }])
  })

  test('pauses use word timing and keep padding', () => {
    const { doc } = sample()
    const pauses = findPauses(doc, { minGap: S(0.7), pad: S(0.1) })
    // 6 s → 12 s entre segmentos
    expect(pauses).toContainEqual({ start: S(6.1), end: S(11.9) })
    // lacunas de 0,5 s entre palavras ficam
    expect(pauses.every((p) => p.end - p.start >= S(0.5))).toBe(true)
  })

  test('extractRange keeps only the window, starting at zero, and preserves locks', () => {
    const { doc } = sample()
    const withLock = setTrackFlags(doc, doc.tracks[0]!.id, { locked: true })
    const out = extractRange(withLock, S(2), S(8))
    expect(docDuration(out)).toBe(S(6))
    expect(clipsOf(out, 'video')[0]!.sourceIn).toBe(S(2))
    expect(out.tracks[0]!.locked).toBe(true)
    expect(out.captions.segments.map((s) => [s.start, s.end])).toEqual([[0, S(4)]])
  })
})

describe('highlight suggestions', () => {
  function talk() {
    let doc = createDocument({ aspect: '16:9' })
    const video = makeMediaClip('video', 'v1', 0, S(180), 'Longo')
    doc = addClip(doc, doc.tracks[0]!.id, video)
    // 0–60 s: fala esparsa; 60–100 s: fala densa começando com pergunta; 120–170 s: média
    for (let t = 0; t < 60; t += 10) doc = addCaption(doc, { start: S(t), end: S(t + 3), text: 'então a gente vai ver' })
    doc = addCaption(doc, { start: S(60), end: S(64), text: 'Você sabia que 90% erram nisso?' })
    for (let t = 64; t < 100; t += 4) doc = addCaption(doc, { start: S(t), end: S(t + 4), text: 'e aqui vem a explicação completa passo a passo com detalhes' })
    for (let t = 120; t < 170; t += 5) doc = addCaption(doc, { start: S(t), end: S(t + 4), text: 'continua o assunto com exemplos' })
    return doc
  }

  test('ranks the dense, hooked window first and returns non-overlapping windows inside 15–60 s', () => {
    const items = suggestHighlights(talk(), { count: 3 })
    expect(items.length).toBeGreaterThan(0)
    const best = [...items].sort((a, b) => b.score - a.score)[0]!
    expect(best.start).toBe(S(60))
    expect(best.reasons.join(' ')).toMatch(/gancho/)
    for (const h of items) {
      expect(h.end - h.start).toBeGreaterThanOrEqual(S(15))
      expect(h.end - h.start).toBeLessThanOrEqual(S(60))
    }
    for (let i = 1; i < items.length; i++) expect(items[i]!.start).toBeGreaterThanOrEqual(items[i - 1]!.end)
  })

  test('energy curve maps source peaks through clip offset, speed and volume', () => {
    let doc = createDocument({ aspect: '16:9' })
    const a = makeMediaClip('audio', 'a1', S(2), S(4), 'A')
    doc = addClip(doc, doc.tracks.find((t) => t.kind === 'audio')!.id, { ...a, sourceIn: S(1) } as never)
    // 10 picos/s: 0 até 3 s, 1 depois
    const peaks = Array.from({ length: 100 }, (_, i) => (i >= 30 ? 1 : 0))
    const curve = energyCurve(doc, new Map([['a1', { peaksPerSecond: 10, peaks }]]))
    expect(curve.length).toBe(6)
    // segundo 2 da timeline = 1–2 s da mídia (silêncio); segundo 4 = 3–4 s (som)
    expect(curve[2]).toBe(0)
    expect(curve[4]).toBe(1)
    expect(curve[0]).toBe(0)
  })

  test('no captions → no suggestions (never invents content)', () => {
    expect(suggestHighlights(createDocument())).toEqual([])
  })
})

describe('formatos pt-BR', () => {
  test('relógio compacto usa vírgula decimal', () => {
    expect(formatClock(S(65.4))).toBe('1:05,4')
    expect(formatClock(0)).toBe('0:00,0')
  })
})
