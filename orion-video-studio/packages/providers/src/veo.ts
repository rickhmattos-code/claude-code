import type { ProviderStatus } from '@orion/shared'
import { downloadTo, request } from './http.ts'
import {
  type Env,
  type Estimate,
  type PollResult,
  type Pricing,
  ProviderError,
  type VideoAdapter,
  type VideoModel,
  type VideoStartInput,
  centsFor,
  missing,
} from './types.ts'

/**
 * Google Veo via Gemini API (REST).
 *
 * Base pesquisada na documentação oficial (ai.google.dev/gemini-api/docs/video):
 *  - POST {base}/models/{model}:predictLongRunning  (cabeçalho x-goog-api-key)
 *    corpo { instances: [{ prompt, image? }], parameters: { aspectRatio, ... } }
 *  - GET  {base}/{operation.name} até `done: true`
 *  - URI do vídeo em response.generateVideoResponse.generatedSamples[0].video.uri,
 *    baixado com o mesmo cabeçalho (seguindo redirecionamento).
 * IDs confirmados: veo-3.1-generate-preview, veo-2.0-generate-001.
 *
 * ATENÇÃO: o host da documentação estava bloqueado no ambiente de
 * desenvolvimento; durações/resoluções abaixo vêm da referência do Vertex AI
 * e devem ser conferidas (docs/providers.md). Lista sobrescrevível por
 * GEMINI_VEO_MODELS_JSON. Este adapter NÃO foi exercitado contra a API real.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

const DEFAULT_MODELS: VideoModel[] = [
  {
    id: 'veo-3.1-generate-preview',
    label: 'Veo 3.1 (preview)',
    modes: ['text-to-video', 'image-to-video'],
    durations: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    aspects: ['16:9', '9:16'],
    audio: true,
    references: true,
    seeds: true,
    extension: false,
    inputFormats: ['image/png', 'image/jpeg'],
    outputFormats: ['video/mp4'],
    notes: 'Gera áudio nativo. Durações 4–8 s (conferir). Referências forçam 8 s segundo a doc do Vertex.',
  },
  {
    id: 'veo-2.0-generate-001',
    label: 'Veo 2',
    modes: ['text-to-video', 'image-to-video'],
    durations: [5, 6, 7, 8],
    resolutions: ['720p'],
    aspects: ['16:9', '9:16'],
    audio: false,
    references: false,
    seeds: true,
    extension: false,
    inputFormats: ['image/png', 'image/jpeg'],
    outputFormats: ['video/mp4'],
    notes: 'Sem áudio. Durações 5–8 s.',
  },
]

function models(env?: Env): VideoModel[] {
  const custom = env?.GEMINI_VEO_MODELS_JSON
  if (custom) {
    try {
      return JSON.parse(custom) as VideoModel[]
    } catch {
      // mantém padrão
    }
  }
  return DEFAULT_MODELS
}

interface Operation {
  name?: string
  done?: boolean
  error?: { message?: string; code?: number }
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string } }>
      raiMediaFilteredReasons?: string[]
    }
  }
}

export const veoAdapter: VideoAdapter = {
  id: 'google-veo',
  label: 'Google Veo (Gemini API)',
  status(env): ProviderStatus {
    const miss = missing(env, ['GEMINI_API_KEY'])
    return {
      id: 'google-veo',
      label: 'Google Veo (Gemini API)',
      kinds: ['VIDEO'],
      configured: miss.length === 0,
      mode: miss.length ? 'pending-config' : 'live',
      missingEnv: miss,
      notes: 'Texto→vídeo e imagem→vídeo, operação longa com consulta de status. Não validado contra a API real neste repositório.',
    }
  },
  models: () => models(process.env),
  estimate(model, durationSeconds, pricing?: Pricing): Estimate {
    return centsFor(pricing?.perSecondCents, durationSeconds, `segundos de ${model}`, pricing)
  },
  async start(input: VideoStartInput, env) {
    const key = env.GEMINI_API_KEY
    if (!key) throw new ProviderError('GEMINI_API_KEY ausente', 'config', false)
    const model = models(env).find((m) => m.id === input.model)
    if (!model) throw new ProviderError(`modelo desconhecido: ${input.model}`, 'invalid', false)
    if (!model.durations.includes(input.durationSeconds)) {
      throw new ProviderError(`${model.label} aceita durações ${model.durations.join(', ')} s`, 'invalid', false)
    }
    if (!model.resolutions.includes(input.resolution)) {
      throw new ProviderError(`${model.label} não suporta ${input.resolution}`, 'invalid', false)
    }
    const instance: Record<string, unknown> = { prompt: input.prompt }
    if (input.mode === 'image-to-video') {
      if (!input.image) throw new ProviderError('imagem de entrada obrigatória', 'invalid', false)
      instance.image = { bytesBase64Encoded: input.image.bytes.toString('base64'), mimeType: input.image.mimeType }
    }
    const parameters: Record<string, unknown> = { aspectRatio: input.aspect, durationSeconds: input.durationSeconds, resolution: input.resolution }
    if (input.negativePrompt) parameters.negativePrompt = input.negativePrompt
    if (input.seed !== undefined && model.seeds) parameters.seed = input.seed
    const res = await request(
      `${BASE}/models/${encodeURIComponent(model.id)}:predictLongRunning`,
      { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ instances: [instance], parameters }), timeoutMs: 60_000 },
      'Veo',
    )
    const op = (await res.json()) as Operation
    if (!op.name) throw new ProviderError('Veo não retornou nome da operação', 'remote', false)
    return { remoteId: op.name }
  },
  async poll(remoteId, env): Promise<PollResult> {
    const key = env.GEMINI_API_KEY
    if (!key) throw new ProviderError('GEMINI_API_KEY ausente', 'config', false)
    if (!/^[\w./-]+$/.test(remoteId)) throw new ProviderError('ID de operação inválido', 'invalid', false)
    const res = await request(`${BASE}/${remoteId}`, { headers: { 'x-goog-api-key': key }, timeoutMs: 30_000 }, 'Veo')
    const op = (await res.json()) as Operation
    if (!op.done) return { state: 'running' }
    if (op.error) return { state: 'failed', error: op.error.message ?? 'erro do provedor' }
    const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    if (!uri) {
      const filtered = op.response?.generateVideoResponse?.raiMediaFilteredReasons?.join('; ')
      return { state: 'failed', error: filtered ? `bloqueado pelo filtro do provedor: ${filtered}` : 'operação concluída sem vídeo' }
    }
    return { state: 'succeeded', result: { uri } }
  },
  async download(result, dst, env) {
    const key = env.GEMINI_API_KEY
    if (!key) throw new ProviderError('GEMINI_API_KEY ausente', 'config', false)
    const uri = (result as { uri?: string }).uri
    if (!uri || !uri.startsWith('https://generativelanguage.googleapis.com/')) {
      throw new ProviderError('URI de download inesperada (bloqueada por segurança)', 'remote', false)
    }
    const res = await request(uri, { headers: { 'x-goog-api-key': key }, redirect: 'follow', timeoutMs: 600_000 }, 'Veo download')
    await downloadTo(res, dst)
  },
}
