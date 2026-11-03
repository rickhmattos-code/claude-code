import type { ProviderStatus } from '@orion/shared'
import { downloadTo, request } from './http.ts'
import { type Env, type MusicAdapter, ProviderError, centsFor, missing } from './types.ts'

/**
 * ElevenLabs Eleven Music — música cantada com letra definida por seção.
 *  POST https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128
 *  cabeçalho xi-api-key; corpo { model_id, composition_plan: {
 *    positive_global_styles, negative_global_styles,
 *    sections: [{ section_name, positive_local_styles, negative_local_styles, duration_ms, lines }] } }
 *  resposta: áudio binário.
 * Contrato montado a partir de trechos da documentação oficial
 * (api-reference/music/compose e guia de composition plans); o domínio da
 * documentação estava bloqueado neste ambiente. Não exercitado contra a API
 * real (sem credencial): validar no primeiro uso. A ElevenLabs recomenda
 * estilos em inglês; as letras vão como escritas (pt-BR).
 */

const BASE = 'https://api.elevenlabs.io/v1'

export const elevenLabsMusicAdapter: MusicAdapter = {
  id: 'elevenlabs-music',
  label: 'ElevenLabs Eleven Music',
  status(env: Env): ProviderStatus {
    const miss = missing(env, ['ELEVENLABS_API_KEY'])
    return {
      id: 'elevenlabs-music',
      label: 'ElevenLabs Eleven Music',
      kinds: ['MUSIC'],
      configured: !miss.length,
      mode: miss.length ? 'pending-config' : 'live',
      missingEnv: miss,
      notes: 'Música cantada com letra por seção (pt-BR anunciado pelo fornecedor; testar a dicção). Uso comercial depende do plano pago. Não use nomes de artistas, títulos ou letras de terceiros.',
    }
  },
  models: () => [
    { id: 'music_v1', label: 'Eleven Music v1', vocals: true, maxSeconds: 300, notes: 'Duração das seções é uma orientação.' },
    { id: 'music_v2_5', label: 'Eleven Music v2.5', vocals: true, maxSeconds: 300, notes: 'Respeita a duração de cada seção. Conferir disponibilidade no plano.' },
  ],
  estimate(model, seconds, pricing) {
    return centsFor(pricing?.perMinuteCents, Math.ceil(seconds / 60), `minuto(s) de música (${model})`, pricing)
  },
  async compose(input, dst, env) {
    const key = env.ELEVENLABS_API_KEY
    if (!key) throw new ProviderError('ELEVENLABS_API_KEY ausente', 'config', false)
    const body = {
      model_id: input.model,
      composition_plan: {
        positive_global_styles: input.styles,
        negative_global_styles: input.negativeStyles,
        sections: input.sections.map((s) => ({
          section_name: s.name,
          positive_local_styles: [],
          negative_local_styles: [],
          duration_ms: Math.round(s.durationSeconds * 1000),
          lines: s.lines,
        })),
      },
    }
    const res = await request(
      `${BASE}/music?output_format=mp3_44100_128`,
      { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 600_000 },
      'ElevenLabs Music',
    )
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('json')) throw new ProviderError('resposta sem áudio', 'remote', true)
    await downloadTo(res, dst)
    return { format: 'mp3' }
  },
}

/** Estilos que nunca devem aparecer em música para crianças. */
export const KIDS_NEGATIVE_STYLES = ['explicit lyrics', 'aggressive', 'distorted', 'scary', 'dark', 'heavy metal screaming', 'sexual']
