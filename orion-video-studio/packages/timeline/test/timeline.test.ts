import { SYSTEM_TEMPLATES, TemplateDefinition, TimelineDoc } from '@orion/shared'
import { describe, expect, test } from 'vitest'
import {
  FLICKS_PER_SECOND,
  SUPPORTED_FPS,
  SUPPORTED_SAMPLE_RATES,
  addCaption,
  addClip,
  applyTemplate,
  assembleScenes,
  createDocument,
  createHistory,
  deleteClips,
  diffSummary,
  docDuration,
  duplicateClip,
  evalPiecewise,
  executeCommand,
  findClip,
  flicksToFrames,
  flicksToSamples,
  formatSecondsArg,
  formatSubtitleTime,
  frameDuration,
  framesToFlicks,
  isFrameAligned,
  keyframePiecewise,
  makeMediaClip,
  makeTextClip,
  mergeCaptions,
  moveClip,
  parseCommand,
  parseSubtitles,
  piecewiseExpr,
  planShots,
  push,
  quantize,
  redo,
  replaceSentenceAudio,
  samplesToFlicks,
  scriptToScenes,
  secondsToFlicks,
  setClipSpeed,
  setKeyframe,
  snapTime,
  splitCaption,
  splitClip,
  splitSentences,
  templateFromDocument,
  toSrt,
  toVtt,
  trimClip,
  undo,
  validateDoc,
  visualStateAt,
  animationFactors,
} from '../src/index.ts'
import { evalFfmpegExpr } from './ffexpr.ts'

const S = (s: number) => secondsToFlicks(s)

function docWithClip() {
  let doc = createDocument({ aspect: '16:9' })
  const main = doc.tracks[0]!
  const clip = makeMediaClip('video', 'asset-1', 0, S(10), 'A')
  doc = addClip(doc, main.id, clip)
  return { doc, clipId: clip.id, trackId: main.id }
}

describe('time base', () => {
  test('every supported frame rate has an integer frame duration', () => {
    for (const fps of SUPPORTED_FPS) {
      const fd = frameDuration(fps)
      expect(Number.isInteger(fd)).toBe(true)
      expect((fd * fps.num) / fps.den).toBe(FLICKS_PER_SECOND)
    }
  })
  test('every supported sample rate maps samples to integer flicks', () => {
    for (const r of SUPPORTED_SAMPLE_RATES) {
      expect(FLICKS_PER_SECOND % r).toBe(0)
      expect(samplesToFlicks(r, r)).toBe(FLICKS_PER_SECOND)
    }
  })
  test('frame/sample conversions do not drift over 15 minutes at 29.97', () => {
    const fps = { num: 30000, den: 1001 }
    const frames = 26973 // ~15 min
    const f = framesToFlicks(frames, fps)
    expect(flicksToFrames(f, fps)).toBe(frames)
    // soma de frames individuais == conversão direta (sem acúmulo de erro)
    let acc = 0
    for (let i = 0; i < frames; i++) acc += frameDuration(fps)
    expect(acc).toBe(f)
    expect(flicksToSamples(f, 48000)).toBe(Math.round((frames * 1001 * 48000) / 30000))
  })
  test('quantize and alignment', () => {
    const fps = { num: 30, den: 1 }
    const t = quantize(S(1.017), fps)
    expect(isFrameAligned(t, fps)).toBe(true)
    expect(flicksToFrames(t, fps)).toBe(31)
  })
  test('ffmpeg seconds formatting is exact and never scientific', () => {
    expect(formatSecondsArg(S(90))).toBe('90.000000')
    expect(formatSecondsArg(framesToFlicks(1, { num: 30000, den: 1001 }))).toBe('0.033367')
    expect(formatSecondsArg(1)).toBe('0.000000')
    expect(formatSubtitleTime(S(3725.5), ',')).toBe('01:02:05,500')
  })
})

describe('editing operations', () => {
  test('split keeps total duration and source continuity', () => {
    const { doc, clipId } = docWithClip()
    const out = splitClip(doc, clipId, S(4))
    const clips = out.tracks[0]!.clips
    expect(clips).toHaveLength(2)
    expect(clips[0]!.duration + clips[1]!.duration).toBe(S(10))
    const right = clips[1]!
    if (right.type !== 'video') throw new Error('tipo')
    expect(right.sourceIn).toBe(S(4))
    expect(right.start).toBe(S(4))
  })
  test('split preserves keyframe curve at the cut point', () => {
    let { doc, clipId } = docWithClip()
    doc = setKeyframe(doc, clipId, 'opacity', 0, 0)
    doc = setKeyframe(doc, clipId, 'opacity', S(10), 1)
    const out = splitClip(doc, clipId, S(5))
    const [l, r] = out.tracks[0]!.clips
    expect(visualStateAt(l!, 5).opacity).toBeCloseTo(0.5, 5)
    expect(visualStateAt(r!, 0).opacity).toBeCloseTo(0.5, 5)
    expect(visualStateAt(r!, 2.5).opacity).toBeCloseTo(0.75, 5)
  })
  test('overlap is rejected and move works across compatible tracks', () => {
    const { doc, clipId, trackId } = docWithClip()
    expect(() => addClip(doc, trackId, makeMediaClip('video', 'b', S(5), S(2), 'B'))).toThrow(/intervalo/)
    const overlay = doc.tracks.find((t) => t.kind === 'overlay')!
    const moved = moveClip(doc, clipId, overlay.id, S(3))
    expect(findClip(moved, clipId)!.track.id).toBe(overlay.id)
    const voice = doc.tracks.find((t) => t.kind === 'voice')!
    expect(() => moveClip(doc, clipId, voice.id, 0)).toThrow(/incompatível/)
  })
  test('locked tracks reject edits', () => {
    const { doc, clipId, trackId } = docWithClip()
    const locked = { ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, locked: true } : t)) }
    expect(() => splitClip(locked, clipId, S(2))).toThrow(/bloqueada/)
  })
  test('ripple delete closes the gap and moves linked captions', () => {
    let doc = createDocument()
    const main = doc.tracks[0]!
    const a = makeMediaClip('video', 'a', 0, S(3), 'A')
    const b = makeMediaClip('video', 'b', S(3), S(4), 'B')
    doc = addClip(addClip(doc, main.id, a), main.id, b)
    doc = addCaption(doc, { start: S(4), end: S(5), text: 'oi', linkedClipId: b.id })
    const out = deleteClips(doc, [a.id], true)
    expect(out.tracks[0]!.clips[0]!.start).toBe(0)
    expect(out.captions.segments[0]!.start).toBe(S(1))
    const noRipple = deleteClips(doc, [a.id], false)
    expect(noRipple.tracks[0]!.clips[0]!.start).toBe(S(3))
  })
  test('trim respects source bounds and neighbours', () => {
    const { doc, clipId } = docWithClip()
    const t = trimClip(doc, clipId, 'end', S(30), S(12))
    expect(findClip(t, clipId)!.clip.duration).toBe(S(12))
    const s = trimClip(doc, clipId, 'start', S(2))
    const c = findClip(s, clipId)!.clip
    expect(c.start).toBe(S(2))
    if (c.type === 'video') expect(c.sourceIn).toBe(S(2))
  })
  test('speed change rescales duration', () => {
    const { doc, clipId } = docWithClip()
    const out = setClipSpeed(doc, clipId, 2)
    expect(findClip(out, clipId)!.clip.duration).toBe(S(5))
  })
  test('duplicate places the copy after the original', () => {
    const { doc, clipId } = docWithClip()
    const { doc: out, newClipId } = duplicateClip(doc, clipId)
    expect(findClip(out, newClipId)!.clip.start).toBe(S(10))
  })
  test('undo/redo history', () => {
    const { doc, clipId } = docWithClip()
    let h = createHistory(doc)
    h = push(h, splitClip(doc, clipId, S(5)))
    expect(h.present.tracks[0]!.clips).toHaveLength(2)
    h = undo(h)
    expect(h.present.tracks[0]!.clips).toHaveLength(1)
    h = redo(h)
    expect(h.present.tracks[0]!.clips).toHaveLength(2)
  })
  test('snapping picks the nearest candidate inside the threshold', () => {
    expect(snapTime(S(4.95), [0, S(5), S(10)], S(0.1))).toEqual({ time: S(5), snapped: true })
    expect(snapTime(S(4.5), [0, S(5)], S(0.1)).snapped).toBe(false)
  })
  test('sentence regeneration: preserve vs shift', () => {
    let doc = createDocument()
    const voice = doc.tracks.find((t) => t.kind === 'voice')!
    const main = doc.tracks[0]!
    const n1 = makeMediaClip('audio', 'v1', 0, S(3), 'Frase 1')
    const n2 = makeMediaClip('audio', 'v2', S(3), S(3), 'Frase 2')
    doc = addClip(addClip(doc, voice.id, n1), voice.id, n2)
    doc = addClip(doc, main.id, makeMediaClip('video', 'x', S(3), S(5), 'Vídeo'))
    const shifted = replaceSentenceAudio(doc, n1.id, 'v1b', S(4), 'shift').doc
    expect(findClip(shifted, n2.id)!.clip.start).toBe(S(4))
    expect(shifted.tracks[0]!.clips[0]!.start).toBe(S(4))
    const preserved = replaceSentenceAudio(doc, n1.id, 'v1b', S(3.3), 'preserve')
    expect(findClip(preserved.doc, n1.id)!.clip.duration).toBe(S(3))
    expect(findClip(preserved.doc, n2.id)!.clip.start).toBe(S(3))
    const tooLong = replaceSentenceAudio(doc, n1.id, 'v1b', S(6), 'preserve')
    expect(tooLong.warning).toMatch(/cortado/)
  })
})

describe('captions', () => {
  test('srt/vtt round trip', () => {
    let doc = createDocument()
    doc = addCaption(doc, { start: S(1), end: S(2.5), text: 'Olá, mundo' })
    doc = addCaption(doc, { start: S(3), end: S(4), text: 'Segunda linha', speaker: 'Ana' })
    const srt = toSrt(doc.captions.segments)
    expect(srt).toContain('00:00:01,000 --> 00:00:02,500')
    const back = parseSubtitles(srt)
    expect(back[0]!.text).toBe('Olá, mundo')
    expect(back[0]!.end).toBe(S(2.5))
    const vtt = toVtt(doc.captions.segments)
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    const vback = parseSubtitles(vtt)
    expect(vback[1]!.speaker).toBe('Ana')
  })
  test('split and merge segments', () => {
    let doc = createDocument()
    doc = addCaption(doc, { start: 0, end: S(4), text: 'um dois três quatro' })
    const id = doc.captions.segments[0]!.id
    const split = splitCaption(doc, id, S(2))
    expect(split.captions.segments.map((s) => s.text)).toEqual(['um dois', 'três quatro'])
    const [a, b] = split.captions.segments
    const merged = mergeCaptions(split, a!.id, b!.id)
    expect(merged.captions.segments).toHaveLength(1)
    expect(merged.captions.segments[0]!.text).toBe('um dois três quatro')
  })
  test('moving a clip moves linked captions predictably', () => {
    const { doc, clipId, trackId } = docWithClip()
    const withCap = addCaption(doc, { start: S(1), end: S(2), text: 'x', linkedClipId: clipId })
    const moved = moveClip(withCap, clipId, trackId, S(5))
    expect(moved.captions.segments[0]!.start).toBe(S(6))
  })
})

describe('preview/export coherence (keyframe expressions)', () => {
  test('ffmpeg expression equals JS evaluation at many sample points', () => {
    let { doc, clipId } = docWithClip()
    doc = setKeyframe(doc, clipId, 'scale', 0, 1, 'easeInOut')
    doc = setKeyframe(doc, clipId, 'scale', S(2), 1.5, 'linear')
    doc = setKeyframe(doc, clipId, 'scale', S(5), 1.2, 'hold')
    doc = setKeyframe(doc, clipId, 'scale', S(8), 2)
    const clip = findClip(doc, clipId)!.clip
    const pw = keyframePiecewise(clip, 'scale')
    const offset = 1.25
    const expr = piecewiseExpr(pw, `(t-${offset})`)
    for (let t = -1; t < 12; t += 0.137) {
      const js = evalPiecewise(pw, t - offset)
      expect(evalFfmpegExpr(expr, { t })).toBeCloseTo(js, 9)
    }
  })
  test('text animations are expressible', () => {
    const text = makeTextClip('Olá', 0, S(3))
    for (const anim of ['fade', 'slide-up', 'pop'] as const) {
      const c = { ...text, animation: anim }
      const f = animationFactors(c)
      for (const p of [...f.opacity, ...f.scale, ...f.dy]) {
        const e = piecewiseExpr(p, 't')
        for (let t = 0; t < 3; t += 0.05) expect(evalFfmpegExpr(e, { t })).toBeCloseTo(evalPiecewise(p, t), 9)
      }
    }
  })
})

describe('templates', () => {
  test('ten system templates validate and apply to every declared aspect', () => {
    expect(SYSTEM_TEMPLATES.length).toBeGreaterThanOrEqual(10)
    const cats = new Set(SYSTEM_TEMPLATES.map((t) => t.category))
    for (const c of ['reflexao', 'vendas', 'institucional', 'historia', 'educativo', 'podcast', 'depoimento', 'lista', 'produto', 'humor']) {
      expect(cats.has(c as never)).toBe(true)
    }
    for (const t of SYSTEM_TEMPLATES) {
      expect(() => TemplateDefinition.parse(t)).not.toThrow()
      for (const aspect of t.aspects) {
        const doc = applyTemplate({ template: t, settings: { aspect } })
        const { issues } = validateDoc(doc)
        expect(issues.filter((i) => i.severity === 'error'), `${t.slug} ${aspect}`).toEqual([])
        expect(docDuration(doc)).toBeGreaterThan(0)
      }
    }
  })
  test('field values fill text and flex scene stretches to target duration', () => {
    const t = SYSTEM_TEMPLATES.find((x) => x.slug === 'reflexao-aurora')!
    const doc = applyTemplate({ template: t, textValues: { frase: 'Você é o que repete.' }, targetSeconds: 90 })
    const texts = doc.tracks.flatMap((tr) => tr.clips).filter((c) => c.type === 'text')
    expect(texts.some((c) => c.type === 'text' && c.text === 'Você é o que repete.')).toBe(true)
    expect(Math.round(docDuration(doc) / FLICKS_PER_SECOND)).toBe(90)
  })
  test('document can be saved back as a valid template', () => {
    const t = SYSTEM_TEMPLATES[1]!
    const doc = applyTemplate({ template: t })
    const tpl = templateFromDocument(doc, { slug: 'meu-template', name: 'Meu', description: 'teste' })
    expect(tpl.scenes.length).toBe(t.scenes.length)
    const again = applyTemplate({ template: tpl })
    expect(validateDoc(again).issues.filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('storyboard', () => {
  const script = `Era uma vez um ferreiro que trabalhava de sol a sol. Ele acreditava que o esforço sozinho resolveria tudo.

Um dia, uma tempestade destruiu sua oficina. Sem ferramentas, ele precisou pedir ajuda pela primeira vez. Os vizinhos vieram, e cada um trouxe algo.

Com a oficina reconstruída, ele entendeu: força também é saber aceitar ajuda.`
  test('script becomes scenes within the max scene duration', () => {
    const scenes = scriptToScenes(script, { maxSceneSeconds: 8, visualStyle: 'Ilustração em aquarela' })
    expect(scenes.length).toBeGreaterThanOrEqual(3)
    for (const s of scenes) {
      expect(s.visualPrompt).toContain('aquarela')
      expect(s.estimatedDuration).toBeGreaterThan(0)
    }
    const total = scenes.reduce((a, s) => a + s.estimatedDuration, 0) / FLICKS_PER_SECOND
    expect(total).toBeGreaterThan(15)
  })
  test('shot planning respects provider durations', () => {
    expect(planShots(13, [4, 6, 8])).toEqual([8, 6])
    expect(planShots(3, [4, 6, 8])).toEqual([4])
    expect(planShots(16, [8])).toEqual([8, 8])
  })
  test('sentence splitter handles long text', () => {
    const long = `${'palavra '.repeat(120)}fim.`
    for (const s of splitSentences(long, 200)) expect(s.length).toBeLessThanOrEqual(200)
  })
  test('assemble scenes builds a >60 s timeline with narration and linked captions', () => {
    const scenes = scriptToScenes(`${script}\n\n${script}\n\n${script}`, { maxSceneSeconds: 8, visualStyle: 'x' })
    const media = scenes.map((s, i) => ({
      sceneKey: s.key,
      visual: { assetId: `img-${i}`, type: 'image' as const, durationFlicks: null },
      narration: {
        assetId: `nar-${i}`,
        durationFlicks: s.estimatedDuration,
        captions: [{ id: 'c', start: 0, end: Math.min(S(1), s.estimatedDuration), text: s.title }],
      },
    }))
    const doc = assembleScenes(createDocument(), scenes, media)
    expect(docDuration(doc)).toBeGreaterThan(S(60))
    const voice = doc.tracks.find((t) => t.kind === 'voice')!
    expect(voice.clips).toHaveLength(scenes.length)
    expect(doc.captions.segments.every((c) => c.linkedClipId)).toBe(true)
    expect(validateDoc(doc).issues.filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('assistant commands', () => {
  test('parses supported commands and previews changes', () => {
    let { doc, clipId } = docWithClip()
    doc = addClip(doc, doc.tracks[0]!.id, makeMediaClip('video', 'b', S(10), S(5), 'B'))
    const split = parseCommand(doc, 'Divida esta cena', { selectedClipId: clipId, playhead: S(4) })
    expect(split.commands[0]!.type).toBe('split')
    const after = executeCommand(doc, split.commands[0]!)
    expect(diffSummary(doc, after).join(' ')).toMatch(/Adicionado/)
    const intro = parseCommand(doc, 'Encurte a introdução em 2 segundos', { playhead: 0 })
    const shortened = executeCommand(doc, intro.commands[0]!)
    expect(docDuration(shortened)).toBe(S(13))
    const music = parseCommand(doc, 'Troque a música', {
      playhead: 0,
      music: [{ id: 'm1', assetId: 'ma', durationFlicks: S(6), title: 'Aurora' }],
    })
    const withMusic = executeCommand(doc, music.commands[0]!)
    const mt = withMusic.tracks.find((t) => t.kind === 'music')!
    expect(mt.clips.reduce((a, c) => a + c.duration, 0)).toBe(docDuration(doc))
    expect(parseCommand(doc, 'Mude a voz', { playhead: 0, voices: [{ id: 'v', name: 'Ana' }] }).requiresPaidGeneration).toBe(true)
    expect(parseCommand(doc, 'faça café', { playhead: 0 }).understood).toBe(false)
  })
})

describe('validation', () => {
  test('rejects overlap, misalignment and missing assets', () => {
    const { doc, clipId } = docWithClip()
    const bad = JSON.parse(JSON.stringify(doc)) as TimelineDoc
    bad.tracks[0]!.clips.push({ ...bad.tracks[0]!.clips[0]!, id: 'other', start: S(5) + 7 })
    const { issues } = validateDoc(bad, { assets: new Map() })
    const codes = issues.map((i) => i.code)
    expect(codes).toContain('overlap')
    expect(codes).toContain('frame_alignment')
    expect(codes).toContain('asset_missing')
    void clipId
  })
})
