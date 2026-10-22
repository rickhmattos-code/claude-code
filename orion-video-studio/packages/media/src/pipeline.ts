import { createHash } from 'node:crypto'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RenderPreset, TimelineDoc } from '@orion/shared'
import {
  FLICKS_PER_SECOND,
  VISUAL_TRACK_KINDS,
  docDuration,
  flicksToFrames,
  formatSecondsArg,
  frameDuration,
  quantize,
  toSrt,
  toVtt,
} from '@orion/timeline'
import { normalizeVideo } from './derivatives.ts'
import { runFfmpeg } from './ffmpeg.ts'
import {
  type FontSet,
  type RenderContext,
  type ResolvedAsset,
  type StemInfo,
  audibleTracksWithAudio,
  buildChunkCommand,
  buildMasterCommand,
  buildStemCommand,
  planChunks,
} from './graph.ts'
import { probeFile } from './probe.ts'

/**
 * Pipeline de renderização (executado no worker, fora do ciclo HTTP):
 *  1 validação (chamador) → 2 snapshot (revisão imutável, chamador)
 *  3 resolução de ativos (chamador baixa os originais)
 *  4 normalização → 5 composição em blocos → 6 mixagem → 7 legendas
 *  8 codificação/mux → 9 validação do resultado → 10 armazenamento (chamador)
 *
 * Idempotência: todo intermediário tem nome derivado do hash do comando;
 * se já existir (tentativa anterior), é reaproveitado. Escritas são
 * atômicas (arquivo .part + rename).
 */

export interface SourceAsset {
  id: string
  kind: 'VIDEO' | 'AUDIO' | 'IMAGE'
  path: string
  width: number | null
  height: number | null
  durationFlicks: number | null
  hasAudio: boolean
}

export interface RenderStageProgress {
  stage: 'normalize' | 'video' | 'audio' | 'mux' | 'validate'
  progress: number
  detail?: string
}

export interface RenderInput {
  doc: TimelineDoc
  preset: RenderPreset
  workDir: string
  assets: Map<string, SourceAsset>
  fonts: FontSet
  signal?: AbortSignal
  onProgress?: (p: RenderStageProgress) => void
  chunkSeconds?: number
  x264Preset?: string
  crf?: number
}

export interface OutputValidation {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; expected: string; actual: string }>
  durationSeconds: number
  videoDurationSeconds: number
  audioDurationSeconds: number | null
  width: number
  height: number
  fps: string
  sizeBytes: number
}

export interface RenderResult {
  outputPath: string
  srtPath: string | null
  vttPath: string | null
  validation: OutputValidation
  reusedIntermediates: number
  totalFlicks: number
  outputWidth: number
  outputHeight: number
}

const exists = async (p: string) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export function outputDimensions(doc: TimelineDoc, resolution: RenderPreset['resolution']): { width: number; height: number } {
  const target = resolution === '1080p' ? 1080 : 720
  const { width, height } = doc.settings
  const short = Math.min(width, height)
  const scale = target / short
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2)
  return { width: even(width * scale), height: even(height * scale) }
}

async function atomicRun(args: string[], out: string, signal?: AbortSignal, onProgress?: (us: number) => void) {
  const part = out.replace(/(\.[a-z0-9]+)$/, '.part$1')
  const idx = args.lastIndexOf(out)
  const a = [...args]
  a[idx] = part
  await runFfmpeg(a, { signal, onProgress })
  await rename(part, out)
}

export async function renderProject(input: RenderInput): Promise<RenderResult> {
  const { doc, workDir, signal } = input
  const report = (p: RenderStageProgress) => input.onProgress?.(p)
  await mkdir(workDir, { recursive: true })
  const cacheDir = join(workDir, 'cache')
  await mkdir(cacheDir, { recursive: true })
  const fps = doc.settings.fps
  const total = quantize(docDuration(doc), fps, 'ceil')
  if (total <= 0) throw new Error('Projeto vazio: adicione ao menos um clipe.')
  const { width: W, height: H } = outputDimensions(doc, input.preset.resolution)
  let reused = 0

  // 4. normalização dos vídeos usados em trilhas visuais
  const usedVisual = new Set<string>()
  for (const t of doc.tracks)
    if (VISUAL_TRACK_KINDS.has(t.kind) && !t.hidden)
      for (const c of t.clips) if (c.type === 'video') usedVisual.add(c.assetId)
  const resolved = new Map<string, ResolvedAsset>()
  const toNormalize = [...usedVisual]
  let done = 0
  for (const id of toNormalize) {
    signal?.throwIfAborted()
    const a = input.assets.get(id)
    if (!a) throw new Error(`ativo ${id} não resolvido`)
    const out = join(cacheDir, `norm_${id}_${fps.num}_${fps.den}_${W}x${H}.mp4`)
    if (await exists(out)) reused++
    else {
      const part = out.replace(/\.mp4$/, '.part.mp4')
      await normalizeVideo(a.path, part, { fps, maxWidth: Math.max(W, H), maxHeight: Math.max(W, H) }, { signal })
      await rename(part, out)
    }
    const info = await probeFile(out)
    resolved.set(id, { id, kind: 'VIDEO', visualPath: out, audioPath: a.hasAudio ? a.path : null, width: info.width ?? W, height: info.height ?? H, durationFlicks: info.durationFlicks ?? a.durationFlicks, hasAudio: a.hasAudio })
    done++
    report({ stage: 'normalize', progress: done / Math.max(1, toNormalize.length), detail: `${done}/${toNormalize.length}` })
  }
  for (const [id, a] of input.assets) {
    if (resolved.has(id)) continue
    resolved.set(id, {
      id,
      kind: a.kind,
      visualPath: a.kind === 'IMAGE' ? a.path : a.kind === 'VIDEO' ? a.path : null,
      audioPath: a.hasAudio ? a.path : null,
      width: a.width ?? W,
      height: a.height ?? H,
      durationFlicks: a.durationFlicks,
      hasAudio: a.hasAudio,
    })
  }

  const burn = input.preset.captions === 'burn' || input.preset.captions === 'both'
  const ctx: RenderContext = {
    doc,
    width: W,
    height: H,
    assets: resolved,
    fonts: input.fonts,
    workDir,
    burnCaptions: burn,
    x264Preset: input.x264Preset ?? 'veryfast',
    crf: input.crf ?? 20,
  }

  // 5. composição em blocos
  const chunks = planChunks(doc, total, input.chunkSeconds ?? 30)
  const totalFrames = chunks.reduce((a, c) => a + c.frames, 0)
  let framesDone = 0
  const chunkFiles: string[] = []
  for (const chunk of chunks) {
    signal?.throwIfAborted()
    const probeCmd = buildChunkCommand(ctx, chunk, 'OUT')
    const key = hash(JSON.stringify(probeCmd))
    const out = join(cacheDir, `chunk_${String(chunk.index).padStart(4, '0')}_${key}.mp4`)
    if (await exists(out)) {
      reused++
    } else {
      const cmd = buildChunkCommand(ctx, chunk, out)
      for (const f of cmd.files) await writeFile(f.path, f.content)
      await atomicRun(cmd.args, out, signal, (us) => {
        const frames = Math.min(chunk.frames, Math.floor((us / 1e6) * (fps.num / fps.den)))
        report({ stage: 'video', progress: (framesDone + frames) / totalFrames, detail: `bloco ${chunk.index + 1}/${chunks.length}` })
      })
    }
    framesDone += chunk.frames
    chunkFiles.push(out)
    report({ stage: 'video', progress: framesDone / totalFrames, detail: `bloco ${chunk.index + 1}/${chunks.length}` })
  }
  const listPath = join(workDir, 'chunks.txt')
  await writeFile(listPath, chunkFiles.map((f) => `file '${f}'`).join('\n'))
  const videoPath = join(workDir, 'video.mp4')
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', videoPath], { signal })

  // 6. áudio: stems por trilha + mestre
  const stems: StemInfo[] = []
  const tracks = audibleTracksWithAudio(ctx)
  let si = 0
  for (const track of tracks) {
    signal?.throwIfAborted()
    const probeCmd = buildStemCommand(ctx, track, total, 'OUT.wav')
    if (!probeCmd) continue
    const key = hash(JSON.stringify(probeCmd))
    const out = join(cacheDir, `stem_${track.id}_${key}.wav`)
    if (await exists(out)) reused++
    else {
      const cmd = buildStemCommand(ctx, track, total, out)!
      for (const f of cmd.files) await writeFile(f.path, f.content)
      await atomicRun(cmd.args, out, signal)
    }
    stems.push({ path: out, kind: track.kind, volume: track.volume, duck: track.duckUnderVoice })
    si++
    report({ stage: 'audio', progress: si / (tracks.length + 1) })
  }
  const audioPath = join(workDir, 'audio.m4a')
  const master = buildMasterCommand(ctx, stems, total, input.preset.normalizeLoudness, audioPath)
  for (const f of master.files) await writeFile(f.path, f.content)
  await runFfmpeg(master.args, { signal })
  report({ stage: 'audio', progress: 1 })

  // 8. mux final
  signal?.throwIfAborted()
  const outputPath = join(workDir, 'output.mp4')
  await runFfmpeg(['-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', outputPath], { signal })
  report({ stage: 'mux', progress: 1 })

  // 7. legendas separadas
  let srtPath: string | null = null
  let vttPath: string | null = null
  if ((input.preset.captions === 'sidecar' || input.preset.captions === 'both') && doc.captions.segments.length) {
    srtPath = join(workDir, 'legendas.srt')
    vttPath = join(workDir, 'legendas.vtt')
    await writeFile(srtPath, toSrt(doc.captions.segments))
    await writeFile(vttPath, toVtt(doc.captions.segments))
  }

  // 9. validação
  report({ stage: 'validate', progress: 0 })
  const validation = await validateOutput(outputPath, { durationFlicks: total, width: W, height: H, fps, frames: flicksToFrames(total, fps) })
  report({ stage: 'validate', progress: 1 })
  if (!validation.ok) {
    const failed = validation.checks.filter((c) => !c.ok).map((c) => `${c.name}: esperado ${c.expected}, obtido ${c.actual}`)
    throw new Error(`Validação do arquivo final falhou — ${failed.join('; ')}`)
  }
  return { outputPath, srtPath, vttPath, validation, reusedIntermediates: reused, totalFlicks: total, outputWidth: W, outputHeight: H }
}

/** Tolerâncias: vídeo ±1 frame; áudio ±(1 frame + 1 quadro AAC de 1024 amostras). */
export async function validateOutput(
  path: string,
  expected: { durationFlicks: number; width: number; height: number; fps: { num: number; den: number }; frames: number },
  opts: { decodeCheck?: boolean } = { decodeCheck: true },
): Promise<OutputValidation> {
  const info = await probeFile(path)
  const raw = info.raw as { streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string; nb_frames?: string }>; format?: { size?: string } }
  const v = raw.streams?.find((s) => s.codec_type === 'video')
  const a = raw.streams?.find((s) => s.codec_type === 'audio')
  const frameSec = expected.fps.den / expected.fps.num
  const exp = expected.durationFlicks / FLICKS_PER_SECOND
  const vd = Number(v?.duration ?? 0)
  const ad = a?.duration ? Number(a.duration) : null
  const checks: OutputValidation['checks'] = []
  const add = (name: string, ok: boolean, e: string, act: string) => checks.push({ name, ok, expected: e, actual: act })
  add('codec de vídeo', v?.codec_name === 'h264', 'h264', String(v?.codec_name))
  add('codec de áudio', a?.codec_name === 'aac', 'aac', String(a?.codec_name))
  add('dimensões', info.width === expected.width && info.height === expected.height, `${expected.width}x${expected.height}`, `${info.width}x${info.height}`)
  add('frames', Number(v?.nb_frames ?? -1) === expected.frames, String(expected.frames), String(v?.nb_frames))
  add('duração do vídeo', Math.abs(vd - exp) <= frameSec + 1e-3, `${exp.toFixed(3)}s ±1 frame`, `${vd.toFixed(3)}s`)
  add('duração do áudio', ad !== null && Math.abs(ad - exp) <= frameSec + 1024 / 48000 + 1e-3, `${exp.toFixed(3)}s ±(1 frame + 1024 amostras)`, `${ad?.toFixed(3)}s`)
  if (opts.decodeCheck) {
    const stderr = await runFfmpeg(['-v', 'error', '-i', path, '-f', 'null', '-'])
    const errors = stderr.split('\n').filter((l) => l.trim() && !/^\s*$/.test(l))
    add('integridade (decodificação completa)', errors.length === 0, 'sem erros', errors.length ? errors.slice(0, 2).join(' | ') : 'sem erros')
  }
  return {
    ok: checks.every((c) => c.ok),
    checks,
    durationSeconds: exp,
    videoDurationSeconds: vd,
    audioDurationSeconds: ad,
    width: info.width ?? 0,
    height: info.height ?? 0,
    fps: `${expected.fps.num}/${expected.fps.den}`,
    sizeBytes: Number(raw.format?.size ?? 0),
  }
}

export { formatSecondsArg, frameDuration }
