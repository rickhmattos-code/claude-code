import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderStatus } from '@orion/shared'
import { runFfmpeg } from '@orion/media'
import { estimateNarrationSeconds } from '@orion/timeline'
import type { Env, ImageAdapter, TranscriptionAdapter, TtsAdapter, VideoAdapter } from './types.ts'

/**
 * Provedores SIMULADOS — ativos somente com PROVIDERS_MOCK=1 (testes
 * automatizados e demonstração offline). Produzem arquivos reais (FFmpeg)
 * com a marca "MODO DE TESTE" gravada na imagem; a interface exibe o selo
 * correspondente. Nunca são usados em produção nem retornam alinhamento
 * palavra a palavra inventado.
 */

const mockStatus = (id: string, label: string, kinds: ProviderStatus['kinds'], env: Env): ProviderStatus => ({
  id,
  label,
  kinds,
  configured: env.PROVIDERS_MOCK === '1',
  mode: env.PROVIDERS_MOCK === '1' ? 'mock' : 'pending-config',
  missingEnv: env.PROVIDERS_MOCK === '1' ? [] : ['PROVIDERS_MOCK=1'],
  notes: 'Simulação para testes: gera mídia sintética marcada como MODO DE TESTE. Custo 0.',
})

async function withText<T>(text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'orion-mock-'))
  const p = join(dir, 't.txt')
  await writeFile(p, text)
  try {
    return await fn(p)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const FONT = process.env.FONTS_DIR ? join(process.env.FONTS_DIR, 'Inter-Bold.otf') : join(import.meta.dirname, '../../../assets/fonts/Inter-Bold.otf')

/** Operações simuladas pendentes: remoteId → momento em que "terminam". */
const pending = new Map<string, { readyAt: number; input: { prompt: string; durationSeconds: number; aspect: string } }>()

export const mockVideoAdapter: VideoAdapter = {
  id: 'mock-video',
  label: 'Vídeo simulado',
  status: (env) => mockStatus('mock-video', 'Vídeo simulado', ['VIDEO'], env),
  models: () => [
    { id: 'mock-video-1', label: 'Simulado', modes: ['text-to-video', 'image-to-video'], durations: [4, 6, 8], resolutions: ['720p', '1080p'], aspects: ['16:9', '9:16'], audio: false, references: true, seeds: true, extension: false, inputFormats: ['image/png', 'image/jpeg'], outputFormats: ['video/mp4'], notes: 'Somente testes.' },
  ],
  estimate: () => ({ cents: 0, basis: 'Provedor simulado (custo zero).' }),
  async start(input) {
    const remoteId = `mock-op-${crypto.randomUUID()}`
    pending.set(remoteId, { readyAt: Date.now() + 300, input })
    return { remoteId }
  },
  async poll(remoteId) {
    // reconciliação após reinício do worker: operação desconhecida é refeita deterministicamente
    const p = pending.get(remoteId)
    if (p && Date.now() < p.readyAt) return { state: 'running', progress: 0.5 }
    return { state: 'succeeded', result: { remoteId, input: p?.input } }
  },
  async download(result, dst) {
    const r = result as { input?: { prompt: string; durationSeconds: number; aspect: string } }
    const input = r.input ?? { prompt: 'cena', durationSeconds: 4, aspect: '16:9' }
    const size = input.aspect === '9:16' ? '720x1280' : '1280x720'
    await withText(`MODO DE TESTE\n${input.prompt.slice(0, 80)}`, (tp) =>
      runFfmpeg(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${input.durationSeconds}`, '-vf', `drawtext=fontfile=${FONT}:textfile=${tp}:fontsize=36:fontcolor=white:box=1:boxcolor=0x000000@0.6:x=(w-text_w)/2:y=(h-text_h)/2`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', dst]),
    )
  },
  async cancel(remoteId) {
    return pending.delete(remoteId)
  },
}

export const mockImageAdapter: ImageAdapter = {
  id: 'mock-image',
  label: 'Imagem simulada',
  status: (env) => mockStatus('mock-image', 'Imagem simulada', ['IMAGE'], env),
  models: () => [{ id: 'mock-image-1', label: 'Simulado', aspects: ['9:16', '16:9', '1:1', '4:5'], outputFormats: ['image/png'], notes: 'Somente testes.' }],
  estimate: () => ({ cents: 0, basis: 'Provedor simulado (custo zero).' }),
  async generate(input, dst) {
    const size = { '9:16': '1080x1920', '16:9': '1920x1080', '1:1': '1080x1080', '4:5': '1080x1350' }[input.aspect]
    await withText(`MODO DE TESTE\n${input.prompt.slice(0, 60)}`, (tp) =>
      runFfmpeg(['-f', 'lavfi', '-i', `gradients=s=${size}:c0=0x1b1e24:c1=0x6e8bff:duration=1:speed=0.00001`, '-vf', `drawtext=fontfile=${FONT}:textfile=${tp}:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, '-frames:v', '1', dst]),
    )
  },
}

export const mockTtsAdapter: TtsAdapter = {
  id: 'mock-tts',
  label: 'Voz simulada',
  status: (env) => mockStatus('mock-tts', 'Voz simulada', ['TTS'], env),
  models: () => [{ id: 'mock-tts-1', label: 'Simulado', languages: ['pt'], timestamps: false, speedRange: [0.7, 1.2] }],
  async voices() {
    return [
      { id: 'mock-voz-a', name: 'Voz de teste A', language: 'pt', previewUrl: null, labels: {} },
      { id: 'mock-voz-b', name: 'Voz de teste B', language: 'pt', previewUrl: null, labels: {} },
    ]
  },
  estimate: () => ({ cents: 0, basis: 'Provedor simulado (custo zero).' }),
  async synthesize(input, dst) {
    // tom modulado com a duração estimada da fala; sem alinhamento (não inventamos timestamps)
    const secs = Math.max(0.8, estimateNarrationSeconds(input.text, input.speed))
    const f = input.voiceId === 'mock-voz-b' ? 180 : 240
    await runFfmpeg(['-f', 'lavfi', '-i', `aevalsrc=0.4*sin(2*PI*${f}*t)*(0.6+0.4*sin(2*PI*4*t)):s=44100:d=${secs.toFixed(3)}`, '-c:a', 'pcm_s16le', '-f', 'wav', dst])
    return { alignment: null, format: 'wav' }
  },
}

export const mockTranscriptionAdapter: TranscriptionAdapter = {
  id: 'mock-transcription',
  label: 'Transcrição simulada',
  status: (env) => mockStatus('mock-transcription', 'Transcrição simulada', ['TRANSCRIPTION'], env),
  models: () => [{ id: 'mock-stt-1', label: 'Simulado', wordTimestamps: false, diarization: false, maxBytes: 1e9 }],
  estimate: () => ({ cents: 0, basis: 'Provedor simulado (custo zero).' }),
  async transcribe() {
    return { text: '[transcrição simulada — MODO DE TESTE]', segments: [{ start: 0, end: 2, text: '[transcrição simulada — MODO DE TESTE]' }], words: null }
  },
}
