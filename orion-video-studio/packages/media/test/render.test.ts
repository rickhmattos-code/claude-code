import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TimelineDoc } from '@orion/shared'
import {
  FLICKS_PER_SECOND,
  addCaption,
  addClip,
  createDocument,
  makeMediaClip,
  makeTextClip,
  secondsToFlicks,
  setKeyframe,
  updateClip,
  visualStateAt,
} from '@orion/timeline'
import { afterAll, describe, expect, test } from 'vitest'
import { bundledFonts, probeFile, renderProject, runFfmpeg, type SourceAsset } from '../src/index.ts'

const FX = resolve(__dirname, '../../../tests/fixtures/media')
const ASSETS = resolve(__dirname, '../../../assets')
const S = secondsToFlicks
const work = mkdtempSync(join(tmpdir(), 'orion-render-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

async function source(id: string, path: string): Promise<SourceAsset> {
  const i = await probeFile(path)
  return { id, kind: i.kind, path, width: i.width, height: i.height, durationFlicks: i.durationFlicks, hasAudio: i.hasAudio }
}

describe('probe rules', () => {
  test('rotation metadata swaps dimensions', async () => {
    const i = await probeFile(join(FX, 'video_25fps_rotated_12s.mp4'))
    expect(i.rotation).toBe(90)
    expect(i.width).toBe(720)
    expect(i.height).toBe(1280)
    expect(i.sampleRate).toBe(22050)
  })
  test('variable frame rate is detected', async () => {
    const i = await probeFile(join(FX, 'video_vfr_10s.mp4'))
    expect(i.variableFrameRate).toBe(true)
  })
  test('image is classified as IMAGE without duration', async () => {
    const i = await probeFile(join(FX, 'image_portrait.png'))
    expect(i.kind).toBe('IMAGE')
    expect(i.durationFlicks).toBeNull()
  })
})

/** Luminância média de uma região num instante (para medir sincronia e posição). */
async function lumaAt(file: string, t: number, crop: string): Promise<number> {
  const out = await runFfmpeg(['-ss', t.toFixed(4), '-i', file, '-frames:v', '1', '-vf', `crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-f', 'null', '-'])
  const m = /YAVG=([\d.]+)/.exec(out)
  return m ? Number(m[1]) : -1
}

describe('render pipeline', () => {
  test('exports a 90 s project with video, image, text, music, narration, keyframes and burned captions', async () => {
    const assets = new Map<string, SourceAsset>()
    assets.set('v1', await source('v1', join(FX, 'video_30fps_1080p_20s.mp4')))
    assets.set('vr', await source('vr', join(FX, 'video_25fps_rotated_12s.mp4')))
    assets.set('vfr', await source('vfr', join(FX, 'video_vfr_10s.mp4')))
    assets.set('img', await source('img', join(FX, 'image_portrait.png')))
    assets.set('mus', await source('mus', join(ASSETS, 'music/aurora-calma.m4a')))
    assets.set('nar', await source('nar', join(FX, 'tone_narration_30s.wav')))
    assets.set('logo', await source('logo', join(FX, 'logo_alpha.png')))

    let doc: TimelineDoc = createDocument({ aspect: '9:16' })
    const [main, overlay, text, voice, music] = doc.tracks
    // 90 s na trilha principal: 20 + 12 + 10 + 48 (imagem)
    doc = addClip(doc, main!.id, makeMediaClip('video', 'v1', 0, S(20), 'Abertura'))
    const rot = makeMediaClip('video', 'vr', S(20), S(12), 'Rotacionado')
    rot.transitionIn = { type: 'dissolve', duration: S(0.5) }
    doc = addClip(doc, main!.id, rot)
    doc = addClip(doc, main!.id, makeMediaClip('video', 'vfr', S(32), S(10), 'VFR'))
    const img = makeMediaClip('image', 'img', S(42), S(48), 'Imagem')
    img.effects = [
      { id: 'e1', type: 'color', brightness: 0.05, contrast: 1.1, saturation: 1.2 },
      { id: 'e2', type: 'vignette', strength: 0.4 },
    ]
    doc = addClip(doc, main!.id, img)
    doc = setKeyframe(doc, img.id, 'scale', 0, 1)
    doc = setKeyframe(doc, img.id, 'scale', S(48), 1.1)
    const logo = makeMediaClip('image', 'logo', 0, S(90), 'Logo')
    logo.fit = 'contain'
    logo.transform = { x: 0.85, y: 0.08, scale: 0.15, rotation: 0, opacity: 0.8 }
    doc = addClip(doc, overlay!.id, logo)
    const title = makeTextClip('Orion Video Studio\nexportação de 90 segundos', S(1), S(5))
    doc = addClip(doc, text!.id, title)
    doc = updateClip(doc, title.id, (c) => {
      if (c.type === 'text') c.animation = 'pop'
    })
    doc = addClip(doc, voice!.id, makeMediaClip('audio', 'nar', S(2), S(30), 'Narração'))
    const m1 = makeMediaClip('audio', 'mus', 0, S(82), 'Música')
    if (m1.type === 'audio') m1.fadeIn = S(1)
    doc = addClip(doc, music!.id, m1)
    const m2 = makeMediaClip('audio', 'mus', S(82), S(8), 'Música (loop)')
    if (m2.type === 'audio') m2.fadeOut = S(2)
    doc = addClip(doc, music!.id, m2)
    doc = addCaption(doc, { start: S(2), end: S(5), text: 'Legenda gravada no vídeo' })
    doc = addCaption(doc, {
      start: S(6),
      end: S(8),
      text: 'Palavra destacada',
      words: [
        { text: 'Palavra', start: S(6), end: S(7) },
        { text: 'destacada', start: S(7), end: S(8) },
      ],
    })

    const stages = new Set<string>()
    const res = await renderProject({
      doc,
      preset: { resolution: '720p', captions: 'both', normalizeLoudness: true },
      workDir: join(work, 'r90'),
      assets,
      fonts: bundledFonts(join(ASSETS, 'fonts')),
      onProgress: (p) => stages.add(p.stage),
      x264Preset: 'ultrafast',
      crf: 28,
    })
    expect(res.validation.ok).toBe(true)
    expect(res.validation.width).toBe(720)
    expect(res.validation.height).toBe(1280)
    expect(res.validation.videoDurationSeconds).toBeCloseTo(90, 1)
    expect(res.srtPath).not.toBeNull()
    expect([...stages]).toEqual(expect.arrayContaining(['normalize', 'video', 'audio', 'mux', 'validate']))

    // retomada: segunda execução reaproveita blocos, normalizações e stems
    const again = await renderProject({
      doc,
      preset: { resolution: '720p', captions: 'both', normalizeLoudness: true },
      workDir: join(work, 'r90'),
      assets,
      fonts: bundledFonts(join(ASSETS, 'fonts')),
      x264Preset: 'ultrafast',
      crf: 28,
    })
    expect(again.reusedIntermediates).toBeGreaterThanOrEqual(3 + 3 + 2)
  }, 600_000)

  test('audio/video sync stays within one frame', async () => {
    const assets = new Map<string, SourceAsset>()
    assets.set('s', await source('s', join(FX, 'sync_flash_beep_12s.mp4')))
    let doc = createDocument({ aspect: '16:9' })
    // começa num offset não trivial e com sourceIn ≠ 0
    const c = makeMediaClip('video', 's', S(1.5), S(10), 'Sync')
    if (c.type === 'video') c.sourceIn = S(1)
    doc = addClip(doc, doc.tracks[0]!.id, c)
    const res = await renderProject({
      doc,
      preset: { resolution: '720p', captions: 'none', normalizeLoudness: false },
      workDir: join(work, 'sync'),
      assets,
      fonts: bundledFonts(join(ASSETS, 'fonts')),
      chunkSeconds: 4, // força fronteiras de bloco no meio do material
      x264Preset: 'ultrafast',
    })
    // flashes de origem em 2, 5, 9 s → na saída em 2.5, 5.5, 9.5 s
    const out = res.outputPath
    const flashLog = await runFfmpeg(['-i', out, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-'])
    const flashes: number[] = []
    let lastT = -1
    for (const line of flashLog.split('\n')) {
      const t = /pts_time:([\d.]+)/.exec(line)
      if (t) lastT = Number(t[1])
      const y = /YAVG=([\d.]+)/.exec(line)
      if (y && Number(y[1]) > 120 && (flashes.length === 0 || lastT - flashes[flashes.length - 1]! > 0.5)) flashes.push(lastT)
    }
    const beepLog = await runFfmpeg(['-i', out, '-vn', '-af', 'silencedetect=noise=-30dB:d=0.02', '-f', 'null', '-'])
    const beeps = [...beepLog.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t < 11.4)
    expect(flashes.map((f) => Math.round(f * 10) / 10)).toEqual([2.5, 5.5, 9.5])
    expect(beeps).toHaveLength(3)
    const frame = 1 / 30
    flashes.forEach((f, i) => {
      expect(Math.abs(f - beeps[i]!)).toBeLessThanOrEqual(frame + 0.005)
    })
  }, 300_000)

  test('keyframed position matches preview evaluation (pixel check)', async () => {
    const assets = new Map<string, SourceAsset>()
    assets.set('logo', await source('logo', join(FX, 'logo_alpha.png')))
    let doc = createDocument({ aspect: '16:9', background: '#000000' })
    const c = makeMediaClip('color' as never, 'x', 0, S(4), 'Caixa')
    void c
    const box = {
      id: 'box',
      type: 'color' as const,
      name: 'Caixa',
      color: '#FFFFFF',
      start: 0,
      duration: S(4),
      transform: { x: 0.5, y: 0.5, scale: 0.1, rotation: 0, opacity: 1 },
      fit: 'cover' as const,
      keyframes: [],
      effects: [],
    }
    doc = addClip(doc, doc.tracks[1]!.id, box)
    doc = setKeyframe(doc, 'box', 'x', 0, 0.2)
    doc = setKeyframe(doc, 'box', 'x', S(4), 0.8)
    const res = await renderProject({
      doc,
      preset: { resolution: '720p', captions: 'none', normalizeLoudness: false },
      workDir: join(work, 'kf'),
      assets,
      fonts: bundledFonts(join(ASSETS, 'fonts')),
      x264Preset: 'ultrafast',
    })
    // em t=2 s a prévia coloca o centro em x = 0.5 → pixel central branco; em x=0.2 preto
    const clip = doc.tracks[1]!.clips[0]!
    expect(visualStateAt(clip, 2).x).toBeCloseTo(0.5, 6)
    expect(await lumaAt(res.outputPath, 2.0, '20:20:630:350')).toBeGreaterThan(200)
    expect(await lumaAt(res.outputPath, 2.0, '20:20:246:350')).toBeLessThan(40)
    // em t=1 s o centro está em x = 0.35 → 448 px
    expect(visualStateAt(clip, 1).x).toBeCloseTo(0.35, 6)
    expect(await lumaAt(res.outputPath, 1.0, '20:20:438:350')).toBeGreaterThan(200)
    void FLICKS_PER_SECOND
  }, 300_000)

  test('text layers are transparent outside the glyphs (regression)', async () => {
    let doc = createDocument({ aspect: '16:9', background: '#000000' })
    const bg = { id: 'bg', type: 'color' as const, name: 'Fundo', color: '#FFFFFF', start: 0, duration: S(2), transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }, fit: 'cover' as const, keyframes: [], effects: [] }
    doc = addClip(doc, doc.tracks[0]!.id, bg)
    const title = makeTextClip('Título', 0, S(2))
    doc = addClip(doc, doc.tracks[2]!.id, title)
    doc = updateClip(doc, title.id, (c) => {
      if (c.type === 'text') c.animation = 'pop'
    })
    const res = await renderProject({
      doc,
      preset: { resolution: '720p', captions: 'none', normalizeLoudness: false },
      workDir: join(work, 'alpha'),
      assets: new Map(),
      fonts: bundledFonts(join(ASSETS, 'fonts')),
      x264Preset: 'ultrafast',
    })
    // canto superior esquerdo: fundo branco deve continuar visível sob a camada de texto
    expect(await lumaAt(res.outputPath, 1.0, '20:20:10:10')).toBeGreaterThan(200)
  }, 300_000)

  test('shape masks cut the layer, follow its transform and feather with the preview sigma', async () => {
    const white = (id: string, effects: unknown[], transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }) =>
      ({ id, type: 'color' as const, name: id, color: '#FFFFFF', start: 0, duration: S(1), transform, fit: 'cover' as const, keyframes: [], effects }) as never
    const render = async (name: string, clip: never) => {
      let doc = createDocument({ aspect: '16:9', background: '#000000' })
      doc = addClip(doc, doc.tracks[0]!.id, clip)
      const res = await renderProject({
        doc,
        preset: { resolution: '720p', captions: 'none', normalizeLoudness: false },
        workDir: join(work, name),
        assets: new Map(),
        fonts: bundledFonts(join(ASSETS, 'fonts')),
        x264Preset: 'ultrafast',
      })
      return res.outputPath
    }
    // elipse central 640×360 sem borda suave
    const hard = await render('mask-hard', white('a', [{ id: 'm', type: 'mask', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0, invert: false }]))
    expect(await lumaAt(hard, 0.5, '10:10:635:355')).toBeGreaterThan(220)
    expect(await lumaAt(hard, 0.5, '10:10:20:20')).toBeLessThan(25)
    // fora da elipse, mas dentro do retângulo que a contém
    expect(await lumaAt(hard, 0.5, '10:10:340:190')).toBeLessThan(25)
    // retângulo invertido: centro escuro, canto claro
    const inv = await render('mask-inv', white('b', [{ id: 'm', type: 'mask', shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0, invert: true }]))
    expect(await lumaAt(inv, 0.5, '10:10:635:355')).toBeLessThan(25)
    expect(await lumaAt(inv, 0.5, '10:10:20:20')).toBeGreaterThan(220)
    // borda suave: na fronteira da elipse a cobertura fica perto de 50%
    const soft = await render('mask-soft', white('c', [{ id: 'm', type: 'mask', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0.1, invert: false }]))
    const edge = await lumaAt(soft, 0.5, '4:4:958:358')
    expect(edge).toBeGreaterThan(80)
    expect(edge).toBeLessThan(170)
    // a máscara acompanha a camada: clipe reduzido à metade e deslocado para x=0,25
    const moved = await render('mask-moved', white('d', [{ id: 'm', type: 'mask', shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0, invert: false }], { x: 0.25, y: 0.5, scale: 0.5, rotation: 0, opacity: 1 }))
    // camada 640×360 centrada em (320, 360); máscara = 320×180 centrada no mesmo ponto
    expect(await lumaAt(moved, 0.5, '10:10:315:355')).toBeGreaterThan(220)
    expect(await lumaAt(moved, 0.5, '10:10:140:355')).toBeLessThan(25)
    expect(await lumaAt(moved, 0.5, '10:10:635:355')).toBeLessThan(25)
  }, 300_000)
})
