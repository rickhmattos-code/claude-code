import { writeFile } from 'node:fs/promises'
import type { ProviderStatus } from '@orion/shared'
import { request } from './http.ts'
import { type Env, ProviderError, type TtsAdapter, type Voice, centsFor, missing } from './types.ts'

/**
 * ElevenLabs — texto para fala com timestamps por caractere.
 *  POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps
 *  cabeçalho xi-api-key; resposta { audio_base64, alignment: { characters,
 *  character_start_times_seconds, character_end_times_seconds } }.
 *  GET https://api.elevenlabs.io/v1/voices para o catálogo.
 * Não exercitado contra a API real neste repositório (sem credencial).
 */

const BASE = 'https://api.elevenlabs.io/v1'

export const elevenLabsAdapter: TtsAdapter = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  status(env: Env): ProviderStatus {
    const miss = missing(env, ['ELEVENLABS_API_KEY'])
    return {
      id: 'elevenlabs',
      label: 'ElevenLabs',
      kinds: ['TTS'],
      configured: !miss.length,
      mode: miss.length ? 'pending-config' : 'live',
      missingEnv: miss,
      notes: 'Narração pt-BR com alinhamento por caractere (legendas palavra a palavra reais). Clonagem de voz só com consentimento registrado.',
    }
  },
  models: () => [
    { id: 'eleven_multilingual_v2', label: 'Multilingual v2', languages: ['pt', 'en', 'es'], timestamps: true, speedRange: [0.7, 1.2] },
  ],
  async voices(env) {
    const key = env.ELEVENLABS_API_KEY
    if (!key) throw new ProviderError('ELEVENLABS_API_KEY ausente', 'config', false)
    const res = await request(`${BASE}/voices`, { headers: { 'xi-api-key': key }, timeoutMs: 20_000 }, 'ElevenLabs')
    const json = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; preview_url?: string; labels?: Record<string, string> }> }
    return (json.voices ?? []).map(
      (v): Voice => ({ id: v.voice_id, name: v.name, language: v.labels?.language ?? null, previewUrl: v.preview_url ?? null, labels: v.labels ?? {} }),
    )
  },
  estimate(model, text, pricing) {
    return centsFor(pricing?.per1kCharsCents, Math.ceil(text.length / 1000), `mil caracteres (${model})`, pricing)
  },
  async synthesize(input, dst, env) {
    const key = env.ELEVENLABS_API_KEY
    if (!key) throw new ProviderError('ELEVENLABS_API_KEY ausente', 'config', false)
    if (!/^[\w-]{1,100}$/.test(input.voiceId)) throw new ProviderError('voz inválida', 'invalid', false)
    const body: Record<string, unknown> = {
      text: input.text,
      model_id: input.model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: input.speed },
    }
    if (input.pronunciationDictionaryIds?.length) {
      body.pronunciation_dictionary_locators = input.pronunciationDictionaryIds.map((id) => ({ pronunciation_dictionary_id: id }))
    }
    const res = await request(
      `${BASE}/text-to-speech/${input.voiceId}/with-timestamps?output_format=mp3_44100_128`,
      { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 120_000 },
      'ElevenLabs',
    )
    const json = (await res.json()) as {
      audio_base64?: string
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
    }
    if (!json.audio_base64) throw new ProviderError('resposta sem áudio', 'remote', true)
    await writeFile(dst, Buffer.from(json.audio_base64, 'base64'))
    const a = json.alignment
    return {
      format: 'mp3',
      alignment: a ? { characters: a.characters, starts: a.character_start_times_seconds, ends: a.character_end_times_seconds } : null,
    }
  },
}
