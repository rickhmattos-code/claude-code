import { join } from 'node:path'
import type { AnyMediaClip, CaptionStyle, Clip, Effect, TimelineDoc, Track } from '@orion/shared'
import {
  FLICKS_PER_SECOND,
  FONT_LINE_EM,
  LINE_HEIGHT,
  TEXT_MAX_WIDTH_RATIO,
  VISUAL_TRACK_KINDS,
  animationFactors,
  audibleTracks,
  clipEnd,
  dissolveExtensions,
  evalPiecewise,
  flicksToFrames,
  flicksToSamples,
  fontPx,
  formatSecondsArg,
  frameDuration,
  isMediaClip,
  keyframePiecewise,
  maskGeometry,
  masksOf,
  type MaskEffect,
  num,
  piecewiseExpr,
  productExpr,
  sumExpr,
  wrapText,
  type Piecewise,
} from '@orion/timeline'
import { buildAss } from './ass.ts'

/**
 * Construção dos comandos FFmpeg de renderização.
 *
 * Vídeo: a timeline é renderizada em BLOCOS (padrão 30 s) — cada bloco abre
 * apenas os clipes que o intersectam, o que limita memória e descritores e
 * permite retomar após falha (blocos prontos são reaproveitados). Os blocos
 * têm número exato de frames e são concatenados sem recodificar.
 *
 * Áudio: um "stem" por trilha audível (posicionamento por amostra exata),
 * depois mixagem mestre com ducking, limitador e normalização de loudness.
 */

export interface ResolvedAsset {
  id: string
  kind: 'VIDEO' | 'AUDIO' | 'IMAGE'
  /** vídeo normalizado (CFR, fps do projeto) ou imagem original */
  visualPath: string | null
  /** arquivo original (para áudio) */
  audioPath: string | null
  width: number
  height: number
  durationFlicks: number | null
  hasAudio: boolean
}

export interface FontSet {
  dir: string
  files: Record<string, string>
}

export interface RenderContext {
  doc: TimelineDoc
  width: number
  height: number
  assets: Map<string, ResolvedAsset>
  fonts: FontSet
  workDir: string
  burnCaptions: boolean
  x264Preset: string
  crf: number
}

export interface BuiltCommand {
  args: string[]
  files: Array<{ path: string; content: string }>
}

const sec = (f: number) => f / FLICKS_PER_SECOND
const fs = (f: number) => formatSecondsArg(f)

function hexColor(c: string, alpha = 1): string {
  const h = c.replace('#', '').slice(0, 6)
  return `0x${h}${alpha < 1 ? `@${alpha.toFixed(3)}` : ''}`
}

export function fontFile(fonts: FontSet, family: string, weight: number): string {
  const fam = family === 'Inter Display' ? 'InterDisplay' : 'Inter'
  const name = { 400: 'Regular', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold' }[weight] ?? 'Bold'
  const key = `${fam}-${name}`
  const f = fonts.files[key]
  if (!f) throw new Error(`fonte ausente: ${key}`)
  return f
}

function atempoChain(speed: number): string[] {
  const out: string[] = []
  let s = speed
  while (s > 2) {
    out.push('atempo=2')
    s /= 2
  }
  while (s < 0.5) {
    out.push('atempo=0.5')
    s /= 0.5
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(6)}`)
  return out
}

function effectFilters(effects: Effect[], outH: number): string[] {
  const out: string[] = []
  for (const e of effects) {
    switch (e.type) {
      case 'color':
        out.push(`eq=brightness=${num(e.brightness * 0.5)}:contrast=${num(e.contrast)}:saturation=${num(e.saturation)}`)
        break
      case 'temperature':
        out.push(`colortemperature=temperature=${e.kelvin}`)
        break
      case 'blur':
        if (e.radius > 0) out.push(`gblur=sigma=${num(Math.max(0.1, (e.radius * outH) / 1080 / 2))}`)
        break
      case 'vignette':
        if (e.strength > 0) out.push(`vignette=angle=${num(0.15 + e.strength * 0.85)}`)
        break
      case 'grain':
        if (e.amount > 0) out.push(`noise=alls=${Math.round(e.amount * 40)}:allf=t`)
        break
      case 'chromakey':
        out.push(`format=yuva420p,chromakey=color=${hexColor(e.color)}:similarity=${num(e.similarity)}:blend=${num(e.blend)}`)
        break
      case 'denoise':
        break // áudio
      case 'mask':
        break // aplicada depois do ajuste de tamanho (maskFilters)
    }
  }
  return out
}

/** Fonte lavfi que gera a máscara (1 frame calculado e repetido) para uma camada w×h. */
export function maskSource(m: MaskEffect, w: number, h: number, fpsStr: string, durationArg: string): string {
  const g = maskGeometry(m, w, h)
  const X = '(X+0.5)'
  const Y = '(Y+0.5)'
  const inside =
    m.shape === 'ellipse'
      ? `lte(pow((${X}-${num(g.cx)})/${num(g.rx)},2)+pow((${Y}-${num(g.cy)})/${num(g.ry)},2),1)`
      : `lte(abs(${X}-${num(g.cx)}),${num(g.rx)})*lte(abs(${Y}-${num(g.cy)}),${num(g.ry)})`
  const lum = m.invert ? `255-255*${inside}` : `255*${inside}`
  const blur = g.sigma > 0.05 ? `,gblur=sigma=${num(g.sigma)}` : ''
  return `color=c=black:s=${w}x${h}:r=${fpsStr}:d=1,format=gray,trim=end_frame=1,geq=lum='${lum}'${blur},loop=loop=-1:size=1,trim=duration=${durationArg},setpts=PTS-STARTPTS`
}

interface Factors {
  opacity: Piecewise[]
  scale: Piecewise[]
  x: Piecewise[]
  y: Piecewise[]
  rotation: Piecewise
}

function clipFactors(clip: Clip): Factors {
  const a = animationFactors(clip)
  return {
    opacity: [keyframePiecewise(clip, 'opacity'), ...a.opacity],
    scale: [keyframePiecewise(clip, 'scale'), ...a.scale],
    x: [keyframePiecewise(clip, 'x'), ...a.dx],
    y: [keyframePiecewise(clip, 'y'), ...a.dy],
    rotation: keyframePiecewise(clip, 'rotation'),
  }
}

const isConst = (p: Piecewise) => p.segments.length === 0 || p.segments.every((s) => s.v0 === s.v1 && s.v0 === p.before && p.after === p.before)

/** Escreve o arquivo de texto do drawtext com as mesmas quebras da prévia. */
export function layoutTextLines(clip: Extract<Clip, { type: 'text' }>, W: number, H: number): { lines: string[]; px: number } {
  const px = fontPx(clip.style.fontSize, W, H)
  const lines = wrapText(clip.text, px, clip.style.fontWeight, W * TEXT_MAX_WIDTH_RATIO, clip.style.fontFamily)
  return { lines, px }
}

export interface ChunkPlan {
  index: number
  start: number
  end: number
  frames: number
}

export function planChunks(doc: TimelineDoc, totalFlicks: number, chunkSeconds = 30): ChunkPlan[] {
  const fps = doc.settings.fps
  const totalFrames = flicksToFrames(totalFlicks, fps, 'ceil')
  const per = Math.max(1, flicksToFrames(chunkSeconds * FLICKS_PER_SECOND, fps, 'floor'))
  const fd = frameDuration(fps)
  const chunks: ChunkPlan[] = []
  for (let f = 0, i = 0; f < totalFrames; f += per, i++) {
    const frames = Math.min(per, totalFrames - f)
    chunks.push({ index: i, start: f * fd, end: (f + frames) * fd, frames })
  }
  return chunks
}

export function buildChunkCommand(ctx: RenderContext, chunk: ChunkPlan, outPath: string): BuiltCommand {
  const { doc, width: W, height: H } = ctx
  const fps = doc.settings.fps
  const fpsStr = `${fps.num}/${fps.den}`
  const chunkDur = chunk.end - chunk.start
  const args: string[] = ['-f', 'lavfi', '-i', `color=c=${hexColor(doc.settings.background)}:s=${W}x${H}:r=${fpsStr}:d=${fs(chunkDur)}`]
  const files: BuiltCommand['files'] = []
  const filters: string[] = []
  let inputIndex = 1
  let last = '0:v'
  let layerN = 0

  for (const track of doc.tracks) {
    if (!VISUAL_TRACK_KINDS.has(track.kind) || track.hidden) continue
    const ext = dissolveExtensions(track)
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      if (clip.type === 'audio') continue
      const end = clipEnd(clip) + (ext.get(clip.id) ?? 0)
      const visStart = Math.max(clip.start, chunk.start)
      const visEnd = Math.min(end, chunk.end)
      if (visEnd <= visStart) continue
      const vis = visEnd - visStart
      const lead = visStart - clip.start
      const off = visStart - chunk.start
      const L = `L${layerN++}`
      const chain: string[] = []
      let srcW = W
      let srcH = H

      if (clip.type === 'video' || clip.type === 'image') {
        const asset = ctx.assets.get(clip.assetId)
        if (!asset?.visualPath) throw new Error(`mídia não resolvida para o clipe "${clip.name}"`)
        srcW = asset.width
        srcH = asset.height
        if (clip.type === 'video') {
          const total = asset.durationFlicks ?? Number.MAX_SAFE_INTEGER
          const fd = frameDuration(fps)
          let srcStart = clip.sourceIn + Math.round(lead * clip.speed)
          if (srcStart > total - fd) srcStart = Math.max(0, total - fd)
          const need = Math.round(vis * clip.speed)
          args.push('-ss', fs(srcStart), '-t', fs(need + 2 * fd), '-i', asset.visualPath)
          chain.push(`setpts=(PTS-STARTPTS)/${num(clip.speed)}`, `fps=${fpsStr}`, `tpad=stop_mode=clone:stop_duration=${fs(vis)}`, `trim=duration=${fs(vis)}`, 'setpts=PTS-STARTPTS')
        } else {
          args.push('-loop', '1', '-framerate', fpsStr, '-t', fs(vis), '-i', asset.visualPath)
          chain.push(`fps=${fpsStr}`, 'setpts=PTS-STARTPTS')
        }
        chain.push(...effectFilters(clip.effects, H))
        const s = clip.fit === 'cover' ? Math.max(W / srcW, H / srcH) : Math.min(W / srcW, H / srcH)
        srcW = Math.max(2, Math.round(srcW * s))
        srcH = Math.max(2, Math.round(srcH * s))
        chain.push(`scale=${srcW}:${srcH}`)
      } else if (clip.type === 'color') {
        args.push('-f', 'lavfi', '-i', `color=c=${hexColor(clip.color)}:s=${W}x${H}:r=${fpsStr}:d=${fs(vis)}`)
        chain.push('setpts=PTS-STARTPTS', ...effectFilters(clip.effects, H))
      } else {
        // texto: tela transparente W×H com o bloco de texto centralizado
        // format=rgba DENTRO do grafo lavfi: sem isso a entrada é convertida para yuv420p e o alfa se perde
        args.push('-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H}:r=${fpsStr}:d=${fs(vis)},format=rgba`)
        const { lines, px } = layoutTextLines(clip, W, H)
        const textPath = join(ctx.workDir, `text_${chunk.index}_${L}.txt`)
        files.push({ path: textPath, content: lines.join('\n') })
        const st = clip.style
        const align = st.align === 'left' ? 'L' : st.align === 'right' ? 'R' : 'C'
        const dt = [
          `fontfile=${fontFile(ctx.fonts, st.fontFamily, st.fontWeight)}`,
          `textfile=${textPath}`,
          `fontsize=${px}`,
          `fontcolor=${hexColor(st.color)}`,
          // altura de linha do drawtext = 1,211 em (métrica da Inter); ajusta para LINE_HEIGHT
          `line_spacing=${Math.round(px * (LINE_HEIGHT - FONT_LINE_EM))}`,
          `text_align=${align}`,
          'x=(w-text_w)/2',
          'y=(h-text_h)/2',
        ]
        if (st.outlineWidth > 0) dt.push(`borderw=${Math.max(1, Math.round((st.outlineWidth * H) / 1080))}`, `bordercolor=${hexColor(st.outlineColor)}`)
        if (st.shadow > 0) {
          const sh = Math.max(1, Math.round((st.shadow * H) / 1080))
          dt.push(`shadowx=${sh}`, `shadowy=${sh}`, 'shadowcolor=0x000000@0.55')
        }
        if (st.background) dt.push('box=1', `boxcolor=${hexColor(st.background)}`, `boxborderw=${Math.round(px * 0.35)}`)
        chain.push('setpts=PTS-STARTPTS', 'format=rgba', `drawtext=${dt.join(':')}`)
      }

      // máscaras: multiplicam o alfa da camada já ajustada (antes de escala/rotação, então acompanham o clipe)
      const clipInput = inputIndex
      let source = `${clipInput}:v`
      const masks = clip.type === 'text' ? [] : masksOf(clip.effects)
      if (masks.length) {
        const pre = `${L}p`
        filters.push(`[${source}]${[...chain, 'format=rgba'].join(',')}[${pre}]`)
        chain.length = 0
        const maskLabels: string[] = []
        for (const m of masks) {
          inputIndex++
          args.push('-f', 'lavfi', '-i', maskSource(m, srcW, srcH, fpsStr, fs(vis)))
          maskLabels.push(`${inputIndex}:v`)
        }
        let acc = maskLabels[0]!
        maskLabels.slice(1).forEach((lbl, i) => {
          const out = `${L}mm${i}`
          filters.push(`[${acc}][${lbl}]blend=all_mode=multiply[${out}]`)
          acc = out
        })
        filters.push(`[${pre}]split[${L}c][${L}c2]`, `[${L}c2]alphaextract[${L}a]`, `[${L}a][${acc}]blend=all_mode=multiply[${L}am]`, `[${L}c][${L}am]alphamerge[${L}m]`)
        source = `${L}m`
      }

      const f = clipFactors(clip)
      const T = `(t+${num(sec(lead))})`
      // opacidade: constante → colorchannelmixer; variável → sendcmd por frame
      const opConst = f.opacity.every(isConst)
      const rotConst = isConst(f.rotation)
      const needsAlpha = !opConst || f.opacity.reduce((a, p) => a * p.before, 1) < 1 || !rotConst || f.rotation.before !== 0 || clip.effects.some((e) => e.type === 'chromakey') || clip.type === 'text' || masks.length > 0
      if (needsAlpha) chain.push('format=rgba')
      if (opConst) {
        const v = f.opacity.reduce((a, p) => a * p.before, 1)
        if (v < 1) chain.push(`colorchannelmixer=aa=${num(Math.max(0, v))}`)
      } else {
        const frames = flicksToFrames(vis, fps, 'ceil')
        const lines: string[] = []
        let prev = Number.NaN
        for (let n = 0; n < frames; n++) {
          const tLocal = sec(lead) + (n * fps.den) / fps.num
          const tClamped = Math.min(tLocal, sec(clip.duration))
          const v = Math.max(0, Math.min(1, f.opacity.reduce((a, p) => a * evalPiecewise(p, tClamped), 1)))
          const r = Math.round(v * 1000) / 1000
          if (r !== prev) {
            lines.push(`${((n * fps.den) / fps.num).toFixed(6)} colorchannelmixer@op${L} aa ${r.toFixed(3)};`)
            prev = r
          }
        }
        const cmdPath = join(ctx.workDir, `op_${chunk.index}_${L}.cmd`)
        files.push({ path: cmdPath, content: lines.join('\n') })
        chain.push(`sendcmd=f=${cmdPath}`, `colorchannelmixer@op${L}=aa=1`)
      }
      if (!rotConst || f.rotation.before !== 0) {
        chain.push(`rotate=a='(${piecewiseExpr(f.rotation, T)})*PI/180':ow='hypot(iw,ih)':oh=ow:c=none`)
      }
      const scaleConst = f.scale.every(isConst)
      if (scaleConst) {
        const v = f.scale.reduce((a, p) => a * p.before, 1)
        if (Math.abs(v - 1) > 1e-6) chain.push(`scale=w='max(2,iw*${num(v)})':h='max(2,ih*${num(v)})'`)
      } else {
        const e = productExpr(f.scale.map((p) => piecewiseExpr(p, T)))
        chain.push(`scale=w='max(2,iw*(${e}))':h='max(2,ih*(${e}))':eval=frame`)
      }
      chain.push(`setpts=PTS+${fs(off)}/TB`)
      filters.push(`[${source}]${chain.join(',') || 'null'}[${L}]`)
      inputIndex++
      const To = `(t-${num(sec(off))}+${num(sec(lead))})`
      const xe = sumExpr(f.x.map((p) => piecewiseExpr(p, To)))
      const ye = sumExpr(f.y.map((p) => piecewiseExpr(p, To)))
      const out = `V${layerN}`
      filters.push(
        `[${last}][${L}]overlay=x='W*(${xe})-w/2':y='H*(${ye})-h/2':eof_action=pass:format=auto:enable='between(t,${num(sec(off))},${num(sec(off + vis) - 1e-6)})'[${out}]`,
      )
      last = out
    }
  }

  const style = doc.captionStyles.find((s) => s.id === doc.captions.styleId) ?? doc.captionStyles[0]
  let tail = `[${last}]`
  const post: string[] = []
  if (ctx.burnCaptions && style && doc.captions.segments.some((s) => s.end > chunk.start && s.start < chunk.end)) {
    const assPath = join(ctx.workDir, `captions_${chunk.index}.ass`)
    files.push({ path: assPath, content: buildAss(doc.captions.segments, style as CaptionStyle, { width: W, height: H, offset: chunk.start, window: chunkDur }) })
    post.push(`ass=filename=${assPath}:fontsdir=${ctx.fonts.dir}`)
  }
  post.push('format=yuv420p')
  filters.push(`${tail}${post.join(',')}[vout]`)
  tail = '[vout]'
  const filterPath = join(ctx.workDir, `graph_${chunk.index}.txt`)
  files.push({ path: filterPath, content: filters.join(';\n') })
  args.push(
    '-filter_complex_script',
    filterPath,
    '-map',
    tail,
    '-frames:v',
    String(chunk.frames),
    '-c:v',
    'libx264',
    '-preset',
    ctx.x264Preset,
    '-crf',
    String(ctx.crf),
    '-pix_fmt',
    'yuv420p',
    '-r',
    fpsStr,
    '-fps_mode',
    'cfr',
    '-video_track_timescale',
    String(fps.num),
    '-an',
    outPath,
  )
  return { args, files }
}

// ---------------------------------------------------------------------------
// Áudio
// ---------------------------------------------------------------------------

function audioSourceFor(ctx: RenderContext, clip: Clip): { clip: AnyMediaClip; path: string; total: number | null } | null {
  if (!isMediaClip(clip) || clip.type === 'image') return null
  const a = ctx.assets.get(clip.assetId)
  if (!a?.hasAudio || !a.audioPath) return null
  return { clip, path: a.audioPath, total: a.durationFlicks }
}

export function trackHasAudio(ctx: RenderContext, track: Track): boolean {
  return track.clips.some((c) => audioSourceFor(ctx, c) !== null)
}

export function buildStemCommand(ctx: RenderContext, track: Track, totalFlicks: number, outPath: string): BuiltCommand | null {
  const sr = ctx.doc.settings.sampleRate
  const totalSamples = flicksToSamples(totalFlicks, sr)
  const ext = dissolveExtensions(track)
  const args: string[] = []
  const filters: string[] = []
  const labels: string[] = []
  let idx = 0
  const sorted = [...track.clips].sort((a, b) => a.start - b.start)
  for (let ci = 0; ci < sorted.length; ci++) {
    const clip = sorted[ci]!
    const src = audioSourceFor(ctx, clip)
    if (!src) continue
    const c = src.clip
    const extra = ext.get(c.id) ?? 0
    const dur = c.duration + extra
    const need = Math.round(dur * c.speed)
    args.push('-ss', fs(c.sourceIn), '-t', fs(need), '-i', src.path)
    const chain = [
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      'asetpts=PTS-STARTPTS',
      ...atempoChain(c.speed),
      `apad=whole_len=${flicksToSamples(dur, sr)}`,
      `atrim=end_sample=${flicksToSamples(dur, sr)}`,
    ]
    const vol = keyframePiecewise(c, 'volume')
    chain.push(isConst(vol) ? `volume=${num(vol.before)}` : `volume='${piecewiseExpr(vol, 't')}':eval=frame`)
    if (c.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${fs(c.fadeIn)}`)
    if (c.transitionIn?.type === 'dissolve') chain.push(`afade=t=in:st=0:d=${fs(c.transitionIn.duration)}`)
    if (extra > 0) chain.push(`afade=t=out:st=${fs(c.duration)}:d=${fs(extra)}`)
    else if (c.fadeOut > 0) chain.push(`afade=t=out:st=${fs(c.duration - c.fadeOut)}:d=${fs(c.fadeOut)}`)
    for (const e of c.effects) if (e.type === 'denoise') chain.push(`afftdn=nr=${num(e.reductionDb)}`)
    chain.push(`adelay=delays=${flicksToSamples(c.start, sr)}S:all=1`)
    filters.push(`[${idx}:a]${chain.join(',')}[a${idx}]`)
    labels.push(`[a${idx}]`)
    idx++
  }
  if (idx === 0) return null
  const mixed = labels.length === 1 ? labels[0]! : `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[mix]`
  if (labels.length > 1) filters.push(mixed)
  const mixLabel = labels.length === 1 ? labels[0]! : '[mix]'
  filters.push(`${mixLabel}apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[out]`)
  const filterPath = outPath.replace(/\.wav$/, '.graph.txt')
  return {
    args: [...args, '-filter_complex_script', filterPath, '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', String(sr), '-ac', '2', outPath],
    files: [{ path: filterPath, content: filters.join(';\n') }],
  }
}

export interface StemInfo {
  path: string
  kind: Track['kind']
  volume: number
  duck: boolean
}

export function buildMasterCommand(
  ctx: RenderContext,
  stems: StemInfo[],
  totalFlicks: number,
  normalizeLoudness: boolean,
  outPath: string,
): BuiltCommand {
  const sr = ctx.doc.settings.sampleRate
  const totalSamples = flicksToSamples(totalFlicks, sr)
  const filterPath = outPath.replace(/\.[a-z0-9]+$/, '.graph.txt')
  if (stems.length === 0) {
    return {
      args: ['-f', 'lavfi', '-i', `anullsrc=r=${sr}:cl=stereo`, '-filter_complex_script', filterPath, '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', outPath],
      files: [{ path: filterPath, content: `[0:a]atrim=end_sample=${totalSamples}[out]` }],
    }
  }
  const args: string[] = []
  const filters: string[] = []
  const voice: string[] = []
  const music: string[] = []
  const duckMusic: string[] = []
  const other: string[] = []
  stems.forEach((s, i) => {
    args.push('-i', s.path)
    filters.push(`[${i}:a]volume=${num(s.volume)}[s${i}]`)
    const l = `[s${i}]`
    if (s.kind === 'voice') voice.push(l)
    else if (s.kind === 'music' && s.duck) duckMusic.push(l)
    else if (s.kind === 'music') music.push(l)
    else other.push(l)
  })
  const bus = (labels: string[], name: string) => {
    if (labels.length === 1) return labels[0]!
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[${name}]`)
    return `[${name}]`
  }
  const finals: string[] = []
  let voiceBus: string | null = null
  if (voice.length) voiceBus = bus(voice, 'voicebus')
  if (duckMusic.length) {
    const mb = bus(duckMusic, 'duckbus')
    if (voiceBus) {
      filters.push(`${voiceBus}asplit=2[vmix][vkey]`)
      filters.push(`${mb}[vkey]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350:makeup=1[ducked]`)
      finals.push('[vmix]', '[ducked]')
      voiceBus = null
    } else finals.push(mb)
  }
  if (voiceBus) finals.push(voiceBus)
  finals.push(...music, ...other)
  const master = finals.length === 1 ? finals[0]! : bus(finals, 'master')
  const post = ['alimiter=limit=0.95:level=disabled']
  if (normalizeLoudness) post.push('loudnorm=I=-14:TP=-1.5:LRA=11', `aresample=${sr}`)
  post.push(`apad=whole_len=${totalSamples}`, `atrim=end_sample=${totalSamples}`)
  filters.push(`${master}${post.join(',')}[out]`)
  return {
    args: [...args, '-filter_complex_script', filterPath, '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-ar', String(sr), '-ac', '2', outPath],
    files: [{ path: filterPath, content: filters.join(';\n') }],
  }
}

export function audibleTracksWithAudio(ctx: RenderContext): Track[] {
  return audibleTracks(ctx.doc).filter((t) => trackHasAudio(ctx, t))
}
