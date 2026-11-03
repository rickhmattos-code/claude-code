import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ProviderStatus } from '@orion/shared'
import { request } from './http.ts'
import { type Env, type ImageAdapter, ProviderError, type TranscriptionAdapter, centsFor, missing } from './types.ts'

/**
 * OpenAI — imagem (gpt-image-1) e transcrição (whisper-1).
 *  POST https://api.openai.com/v1/images/generations  { model, prompt, size, n } → data[0].b64_json
 *  POST https://api.openai.com/v1/audio/transcriptions (multipart) response_format=verbose_json,
 *       timestamp_granularities[]=word|segment → { text, segments[], words[] }
 * Não exercitado contra a API real neste repositório (sem credencial).
 */

const BASE = 'https://api.openai.com/v1'

function statusFor(id: string, label: string, kinds: ProviderStatus['kinds'], env: Env, notes: string): ProviderStatus {
  const miss = missing(env, ['OPENAI_API_KEY'])
  return { id, label, kinds, configured: !miss.length, mode: miss.length ? 'pending-config' : 'live', missingEnv: miss, notes }
}

const SIZES: Record<string, string> = { '9:16': '1024x1536', '4:5': '1024x1536', '16:9': '1536x1024', '1:1': '1024x1024' }

export const openAiImageAdapter: ImageAdapter = {
  id: 'openai-image',
  label: 'OpenAI Images',
  status: (env) => statusFor('openai-image', 'OpenAI Images', ['IMAGE'], env, 'Imagens de storyboard (gpt-image-1). 4:5 usa 1024×1536 e é recortado no editor.'),
  models: () => [{ id: 'gpt-image-1', label: 'GPT Image 1', aspects: ['9:16', '16:9', '1:1', '4:5'], outputFormats: ['image/png'], notes: 'Tamanhos 1024×1024, 1536×1024, 1024×1536.' }],
  estimate: (model, pricing) => centsFor(pricing?.perImageCents, 1, `imagem (${model})`, pricing),
  async generate(input, dst, env) {
    const key = env.OPENAI_API_KEY
    if (!key) throw new ProviderError('OPENAI_API_KEY ausente', 'config', false)
    const res = await request(
      `${BASE}/images/generations`,
      { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: input.model, prompt: input.prompt, size: SIZES[input.aspect], n: 1 }), timeoutMs: 180_000 },
      'OpenAI Images',
    )
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> }
    const b64 = json.data?.[0]?.b64_json
    if (!b64) throw new ProviderError('resposta sem imagem', 'remote', true)
    await writeFile(dst, Buffer.from(b64, 'base64'))
  },
}

export const openAiTranscriptionAdapter: TranscriptionAdapter = {
  id: 'openai-transcription',
  label: 'OpenAI Whisper',
  status: (env) => statusFor('openai-transcription', 'OpenAI Whisper', ['TRANSCRIPTION'], env, 'Transcrição com timestamps de palavra e segmento. Sem identificação de locutor.'),
  models: () => [{ id: 'whisper-1', label: 'Whisper', wordTimestamps: true, diarization: false, maxBytes: 25 * 1024 * 1024 }],
  estimate: (model, seconds, pricing) => centsFor(pricing?.perMinuteCents, Math.ceil(seconds / 60), `minutos (${model})`, pricing),
  async transcribe(input, env) {
    const key = env.OPENAI_API_KEY
    if (!key) throw new ProviderError('OPENAI_API_KEY ausente', 'config', false)
    const st = await stat(input.path)
    if (st.size > 25 * 1024 * 1024) throw new ProviderError('arquivo acima de 25 MB: o worker deve dividir o áudio', 'invalid', false)
    const form = new FormData()
    form.append('file', new Blob([await readFile(input.path)]), basename(input.path))
    form.append('model', input.model)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')
    form.append('language', input.language.slice(0, 2))
    const res = await request(`${BASE}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, timeoutMs: 600_000 }, 'OpenAI Whisper')
    const json = (await res.json()) as { text?: string; segments?: Array<{ start: number; end: number; text: string }>; words?: Array<{ word: string; start: number; end: number }> }
    return {
      text: json.text ?? '',
      segments: (json.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
      words: json.words ? json.words.map((w) => ({ text: w.word, start: w.start, end: w.end })) : null,
    }
  },
}
