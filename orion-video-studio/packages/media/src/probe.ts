import { FLICKS_PER_SECOND, secondsToFlicks } from '@orion/timeline'
import { runFfprobe } from './ffmpeg.ts'

/**
 * Inspeção de mídia com ffprobe e regras de normalização.
 *
 * Regras (docs/media-rules.md):
 *  - Duração autoritativa: menor duração entre os streams de vídeo e áudio
 *    presentes (evita "rabo" mudo/preto quando o contêiner diverge); se
 *    nenhum stream tiver duração, usa a do contêiner.
 *  - Frame rate variável (VFR): detectado quando r_frame_rate ≠ avg_frame_rate
 *    (> 0,5% de diferença). Toda mídia de vídeo é normalizada para CFR no
 *    frame rate do projeto antes da composição.
 *  - Rotação: lida da display matrix (side_data) ou tag rotate; largura e
 *    altura reportadas já consideram a rotação (o FFmpeg aplica autorotate).
 *  - Áudio: qualquer sample rate/canais; reamostrado para 48 kHz estéreo
 *    na mixagem.
 */

export interface MediaInfo {
  kind: 'VIDEO' | 'AUDIO' | 'IMAGE'
  formatName: string
  durationFlicks: number | null
  containerDurationFlicks: number | null
  width: number | null
  height: number | null
  rotation: number
  fps: { num: number; den: number } | null
  variableFrameRate: boolean
  videoCodec: string | null
  hasVideo: boolean
  hasAudio: boolean
  audioCodec: string | null
  sampleRate: number | null
  channels: number | null
  durationDivergenceMs: number
  raw: unknown
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  nb_frames?: string
  sample_rate?: string
  channels?: number
  disposition?: { attached_pic?: number }
  tags?: Record<string, string>
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>
}

interface ProbeJson {
  streams?: ProbeStream[]
  format?: { format_name?: string; duration?: string; size?: string }
}

function parseRate(r?: string): { num: number; den: number } | null {
  if (!r) return null
  const [n, d] = r.split('/').map(Number)
  if (!n || !d) return null
  return { num: n, den: d }
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'gif', 'tiff'])

/**
 * Formatos de contêiner aceitos em uploads. Playlists (hls, concat, etc.)
 * são recusadas: poderiam fazer o FFmpeg acessar a rede ou outros arquivos.
 */
export const ALLOWED_FORMATS = /^(mov,mp4,m4a,3gp,3g2,mj2|matroska,webm|mp3|wav|ogg|flac|aac|png_pipe|jpeg_pipe|webp_pipe|image2|srt|webvtt)$/

export async function probeFile(path: string, timeoutMs = 60_000, untrusted = false): Promise<MediaInfo> {
  const guard = untrusted ? ['-protocol_whitelist', 'file'] : []
  const out = await runFfprobe(['-print_format', 'json', '-show_format', '-show_streams', ...guard, path], { timeoutMs })
  const json = JSON.parse(out) as ProbeJson
  return interpretProbe(json)
}

export function interpretProbe(json: ProbeJson): MediaInfo {
  const streams = json.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find((s) => s.codec_type === 'audio')
  const formatName = json.format?.format_name ?? 'desconhecido'
  const isImage =
    !!video &&
    !audio &&
    (IMAGE_CODECS.has(video.codec_name ?? '') || /image2|png_pipe|jpeg_pipe|webp_pipe/.test(formatName)) &&
    (video.nb_frames === undefined || Number(video.nb_frames) <= 1)
  let rotation = 0
  const sd = video?.side_data_list?.find((s) => s.side_data_type === 'Display Matrix')
  if (sd?.rotation !== undefined) rotation = Math.round(-sd.rotation)
  else if (video?.tags?.rotate) rotation = Number(video.tags.rotate)
  rotation = ((rotation % 360) + 360) % 360
  let width = video?.width ?? null
  let height = video?.height ?? null
  if (width && height && (rotation === 90 || rotation === 270)) [width, height] = [height, width]
  const r = parseRate(video?.r_frame_rate)
  const avg = parseRate(video?.avg_frame_rate)
  let vfr = false
  if (r && avg && !isImage) {
    const rv = r.num / r.den
    const av = avg.num / avg.den
    vfr = Math.abs(rv - av) / rv > 0.005
  }
  const durs: number[] = []
  if (video?.duration && !isImage) durs.push(Number(video.duration))
  if (audio?.duration) durs.push(Number(audio.duration))
  const container = json.format?.duration ? Number(json.format.duration) : null
  const valid = durs.filter((d) => Number.isFinite(d) && d > 0)
  const authoritative = isImage ? null : valid.length ? Math.min(...valid) : container
  const divergence = valid.length > 1 ? (Math.max(...valid) - Math.min(...valid)) * 1000 : 0
  return {
    kind: isImage ? 'IMAGE' : video ? 'VIDEO' : 'AUDIO',
    formatName,
    durationFlicks: authoritative && Number.isFinite(authoritative) ? secondsToFlicks(authoritative) : null,
    containerDurationFlicks: container && Number.isFinite(container) ? secondsToFlicks(container) : null,
    width,
    height,
    rotation,
    fps: isImage ? null : (avg && avg.num > 0 ? avg : r),
    variableFrameRate: vfr,
    videoCodec: video?.codec_name ?? null,
    hasVideo: !!video,
    hasAudio: !!audio,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
    durationDivergenceMs: Math.round(divergence),
    raw: json,
  }
}

export const flicksToSecondsStr = (f: number) => (f / FLICKS_PER_SECOND).toFixed(3)
