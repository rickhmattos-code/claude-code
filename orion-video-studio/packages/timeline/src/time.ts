import type { FrameRate } from '@orion/shared'

/**
 * Base temporal: FLICKS — 705.600.000 unidades por segundo.
 *
 * Divide exatamente:
 *  - frame rates 24000/1001, 24, 25, 30000/1001, 30, 48, 50, 60000/1001, 60
 *  - taxas de amostragem 8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000, 192000
 *
 * Toda conversão é feita em BigInt para evitar perda de precisão em produtos
 * intermediários (ex.: 15 min × 60000 > 2^53). Valores armazenados cabem em
 * Number seguro até ~147 dias.
 */
export const FLICKS_PER_SECOND = 705_600_000
const F = BigInt(FLICKS_PER_SECOND)

export const SUPPORTED_FPS: ReadonlyArray<FrameRate & { label: string }> = [
  { num: 24000, den: 1001, label: '23,976' },
  { num: 24, den: 1, label: '24' },
  { num: 25, den: 1, label: '25' },
  { num: 30000, den: 1001, label: '29,97' },
  { num: 30, den: 1, label: '30' },
  { num: 50, den: 1, label: '50' },
  { num: 60000, den: 1001, label: '59,94' },
  { num: 60, den: 1, label: '60' },
]

export const SUPPORTED_SAMPLE_RATES = [
  8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000, 192000,
] as const

export function isSupportedFps(fps: FrameRate): boolean {
  return (F * BigInt(fps.den)) % BigInt(fps.num) === 0n
}

export function assertSupportedFps(fps: FrameRate): void {
  if (!isSupportedFps(fps)) {
    throw new RangeError(`frame rate ${fps.num}/${fps.den} não suportado`)
  }
}

function toSafe(v: bigint): number {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new RangeError('tempo fora do intervalo seguro')
  return n
}

/** Duração de um frame em flicks (inteiro exato para fps suportados). */
export function frameDuration(fps: FrameRate): number {
  assertSupportedFps(fps)
  return toSafe((F * BigInt(fps.den)) / BigInt(fps.num))
}

export function framesToFlicks(frames: number, fps: FrameRate): number {
  assertSupportedFps(fps)
  return toSafe((BigInt(frames) * F * BigInt(fps.den)) / BigInt(fps.num))
}

export type Rounding = 'floor' | 'round' | 'ceil'

function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  const q = n / d
  const r = n % d
  if (r === 0n) return q
  const neg = n < 0n !== d < 0n
  if (mode === 'floor') return neg ? q - 1n : q
  if (mode === 'ceil') return neg ? q : q + 1n
  const twice = (r < 0n ? -r : r) * 2n
  const absD = d < 0n ? -d : d
  if (twice >= absD) return neg ? q - 1n : q + 1n
  return q
}

export function flicksToFrames(
  flicks: number,
  fps: FrameRate,
  rounding: Rounding = 'round',
): number {
  return toSafe(divRound(BigInt(flicks) * BigInt(fps.num), F * BigInt(fps.den), rounding))
}

/** Quantiza um tempo para o grid de frames do projeto. */
export function quantize(flicks: number, fps: FrameRate, rounding: Rounding = 'round'): number {
  return framesToFlicks(flicksToFrames(flicks, fps, rounding), fps)
}

export function isFrameAligned(flicks: number, fps: FrameRate): boolean {
  return (BigInt(flicks) * BigInt(fps.num)) % (F * BigInt(fps.den)) === 0n
}

export function samplesToFlicks(samples: number, sampleRate: number): number {
  return toSafe((BigInt(samples) * F) / BigInt(sampleRate))
}

export function flicksToSamples(
  flicks: number,
  sampleRate: number,
  rounding: Rounding = 'round',
): number {
  return toSafe(divRound(BigInt(flicks) * BigInt(sampleRate), F, rounding))
}

/** Somente em fronteiras (entrada do ffprobe, UI). */
export function secondsToFlicks(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new RangeError('segundos inválidos')
  return Math.round(seconds * FLICKS_PER_SECOND)
}

export function flicksToSeconds(flicks: number): number {
  return flicks / FLICKS_PER_SECOND
}

/**
 * Representação decimal exata (truncada em microssegundos, arredondada) para
 * argumentos do FFmpeg. Nunca usa notação científica.
 */
export function formatSecondsArg(flicks: number): string {
  const neg = flicks < 0
  const us = divRound(BigInt(Math.abs(flicks)) * 1_000_000n, F, 'round')
  const whole = us / 1_000_000n
  const frac = (us % 1_000_000n).toString().padStart(6, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

/** Timecode HH:MM:SS:FF (sem drop-frame) para exibição. */
export function formatTimecode(flicks: number, fps: FrameRate): string {
  const frames = flicksToFrames(flicks, fps, 'floor')
  const nominal = Math.round(fps.num / fps.den)
  const ff = frames % nominal
  const totalSeconds = Math.floor(frames / nominal)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
}

/** mm:ss.d para exibição compacta (baseado no tempo real). */
export function formatClock(flicks: number): string {
  const tenths = Number(divRound(BigInt(flicks) * 10n, F, 'floor'))
  const m = Math.floor(tenths / 600)
  const s = Math.floor((tenths % 600) / 10)
  const d = tenths % 10
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

/** Formato SRT: HH:MM:SS,mmm  | VTT: HH:MM:SS.mmm */
export function formatSubtitleTime(flicks: number, sep: ',' | '.'): string {
  const ms = Number(divRound(BigInt(flicks) * 1000n, F, 'round'))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const r = ms % 1000
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`
}

export function parseSubtitleTime(value: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim())
  if (!m) throw new SyntaxError(`timestamp inválido: ${value}`)
  const h = Number(m[1] ?? 0)
  const mi = Number(m[2])
  const s = Number(m[3])
  const ms = Number((m[4] ?? '0').padEnd(3, '0'))
  const totalMs = ((h * 60 + mi) * 60 + s) * 1000 + ms
  return toSafe((BigInt(totalMs) * F) / 1000n)
}

export const seconds = (s: number) => secondsToFlicks(s)
