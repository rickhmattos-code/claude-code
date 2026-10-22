import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatSecondsArg, secondsToFlicks } from '@orion/timeline'
import { FFMPEG, runFfmpeg, type RunOptions } from './ffmpeg.ts'
import type { MediaInfo } from './probe.ts'

/** Derivados de mídia gerados no worker (miniatura, waveform, proxy, normalização). */

export async function makeThumbnail(src: string, dst: string, info: MediaInfo, opts: RunOptions = {}) {
  const at = info.kind === 'VIDEO' && info.durationFlicks ? Math.min(1, (info.durationFlicks / 705_600_000) * 0.1) : 0
  const args =
    info.kind === 'IMAGE'
      ? ['-i', src, '-vf', 'scale=320:-2', '-frames:v', '1', dst]
      : ['-ss', at.toFixed(3), '-i', src, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '4', dst]
  await runFfmpeg(args, { timeoutMs: 60_000, ...opts })
}

/**
 * Picos da forma de onda: decodifica para PCM mono 8 kHz via pipe (memória
 * constante) e guarda o pico por bloco. ~100 picos/s, limitado a 60.000.
 */
export function computePeaks(src: string, durationSeconds: number, opts: RunOptions = {}): Promise<{ peaksPerSecond: number; peaks: number[] }> {
  const rate = 8000
  const peaksPerSecond = durationSeconds > 600 ? Math.max(10, Math.floor(60_000 / durationSeconds)) : 100
  const block = Math.floor(rate / peaksPerSecond)
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const peaks: number[] = []
    let current = 0
    let count = 0
    let carry: Buffer | null = null
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
    child.stdout.on('data', (chunk: Buffer) => {
      const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 2)
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i))
        if (v > current) current = v
        if (++count >= block) {
          peaks.push(Math.round((current / 32768) * 1000) / 1000)
          current = 0
          count = 0
        }
      }
      carry = usable < buf.length ? buf.subarray(usable) : null
    })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code !== 0) return reject(new Error(`waveform falhou: ${err.slice(-500)}`))
      if (count > 0) peaks.push(Math.round((current / 32768) * 1000) / 1000)
      resolve({ peaksPerSecond, peaks })
    })
  })
}

/**
 * Proxies leves para prévia no navegador (540p no lado menor, CFR até 30 fps).
 * Dois formatos: MP4 H.264/AAC (Chrome, Edge, Safari, Firefox) e WebM
 * VP9/Opus (navegadores sem codecs proprietários, ex.: Chromium puro).
 * A prévia escolhe por canPlayType; a exportação nunca usa proxies.
 */
export async function makeProxy(src: string, dst: string, info: MediaInfo, opts: RunOptions = {}, webmDst?: string) {
  if (info.kind === 'VIDEO') {
    const fps = info.fps ? Math.min(30, Math.round(info.fps.num / info.fps.den) || 30) : 30
    const portrait = (info.height ?? 0) > (info.width ?? 0)
    const scale = portrait ? 'scale=540:-2' : 'scale=-2:540'
    const vf = `${scale},fps=${fps},format=yuv420p`
    await runFfmpeg(['-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', String(fps), '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-movflags', '+faststart', dst], opts)
    if (webmDst) {
      await runFfmpeg(['-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '0', '-crf', '38', '-g', String(fps), '-c:a', 'libopus', '-b:a', '64k', '-ac', '2', webmDst], opts)
    }
  } else if (info.kind === 'AUDIO') {
    await runFfmpeg(['-i', src, '-vn', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', dst], opts)
    if (webmDst) await runFfmpeg(['-i', src, '-vn', '-c:a', 'libopus', '-b:a', '96k', '-ac', '2', '-ar', '48000', webmDst], opts)
  }
}

/**
 * Normalização para composição: CFR no fps do projeto, rotação aplicada,
 * yuv420p, GOP curto (busca precisa), limitado ao tamanho de saída.
 */
export async function normalizeVideo(
  src: string,
  dst: string,
  target: { fps: { num: number; den: number }; maxWidth: number; maxHeight: number },
  opts: RunOptions = {},
) {
  const fps = `${target.fps.num}/${target.fps.den}`
  const vf = [
    `scale='min(${target.maxWidth},iw)':'min(${target.maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `fps=${fps}`,
    'format=yuv420p',
    'setsar=1',
  ].join(',')
  await runFfmpeg(['-i', src, '-map', '0:v:0', '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '15', '-bf', '0', '-fps_mode', 'cfr', dst], opts)
}

export async function extractFrame(src: string, atFlicks: number, dst: string, opts: RunOptions = {}) {
  await runFfmpeg(['-ss', formatSecondsArg(atFlicks), '-i', src, '-frames:v', '1', dst], { timeoutMs: 60_000, ...opts })
}

export async function extractAudio(src: string, dst: string, opts: RunOptions = {}) {
  await runFfmpeg(['-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', dst], opts)
}

/**
 * Reprodução reversa com memória limitada: inverte blocos de 2 s e
 * concatena em ordem inversa (o filtro reverse sozinho guardaria o trecho
 * inteiro em RAM).
 */
export async function reverseSegment(
  src: string,
  sourceInFlicks: number,
  durationFlicks: number,
  workDir: string,
  dst: string,
  hasAudio: boolean,
  opts: RunOptions = {},
) {
  await mkdir(workDir, { recursive: true })
  const block = secondsToFlicks(2)
  const parts: string[] = []
  for (let off = 0, i = 0; off < durationFlicks; off += block, i++) {
    const len = Math.min(block, durationFlicks - off)
    const part = join(workDir, `rev_${String(i).padStart(5, '0')}.mp4`)
    await runFfmpeg(
      ['-ss', formatSecondsArg(sourceInFlicks + off), '-t', formatSecondsArg(len), '-i', src, '-vf', 'reverse,format=yuv420p', ...(hasAudio ? ['-af', 'areverse', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : ['-an']), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', part],
      opts,
    )
    parts.push(part)
  }
  const list = join(workDir, 'rev_list.txt')
  await writeFile(list, parts.reverse().map((p) => `file '${p}'`).join('\n'))
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', dst], opts)
}

/** Detecção de silêncio para sugestão de cortes. Retorna intervalos em flicks. */
export async function detectSilence(src: string, noiseDb = -35, minSeconds = 0.6, opts: RunOptions = {}) {
  const stderr = await runFfmpeg(['-i', src, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, '-f', 'null', '-'], opts)
  const out: Array<{ start: number; end: number }> = []
  let start: number | null = null
  for (const line of stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line)
    if (s) start = Math.max(0, Number(s[1]))
    const e = /silence_end: ([\d.]+)/.exec(line)
    if (e && start !== null) {
      out.push({ start: secondsToFlicks(start), end: secondsToFlicks(Number(e[1])) })
      start = null
    }
  }
  return out
}
