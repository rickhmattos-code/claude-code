import type { CaptionSegment } from '@orion/shared'
import { z } from 'zod'
import { extractJson } from './assistant.ts'
import { anthropicAdapter } from './anthropic.ts'
import { type Env, ProviderError, type ScriptAdapter } from './types.ts'

/**
 * Tradução de legendas por LLM. Os tempos são preservados; o tempo por
 * palavra é descartado (deixa de corresponder ao texto traduzido). Sem
 * provedor configurado não há tradução: nunca devolvemos texto "traduzido"
 * inventado. O simulador só existe com PROVIDERS_MOCK=1 e marca cada linha.
 */

export const TRANSLATION_LANGUAGES = {
  en: 'inglês',
  es: 'espanhol',
  fr: 'francês',
  it: 'italiano',
  de: 'alemão',
  'pt-BR': 'português do Brasil',
  'pt-PT': 'português de Portugal',
} as const
export type TranslationLanguage = keyof typeof TRANSLATION_LANGUAGES

const mockTranslator: ScriptAdapter = {
  id: 'mock-translation',
  label: 'Tradução simulada',
  status: (env) => ({
    id: 'mock-translation',
    label: 'Tradução simulada',
    kinds: ['SCRIPT'],
    configured: env.PROVIDERS_MOCK === '1',
    mode: env.PROVIDERS_MOCK === '1' ? 'mock' : 'pending-config',
    missingEnv: env.PROVIDERS_MOCK === '1' ? [] : ['PROVIDERS_MOCK=1'],
    notes: 'Simulação para testes: prefixa cada legenda com [TESTE→idioma]; não traduz.',
  }),
  async complete(input) {
    const lang = /IDIOMA=([\w-]+)/.exec(input.prompt)?.[1] ?? '?'
    const items = (extractJson(input.prompt.slice(input.prompt.indexOf('{'))) as { items: Array<{ i: number; text: string }> }).items
    return JSON.stringify({ items: items.map((x) => ({ i: x.i, text: `[TESTE→${lang}] ${x.text}` })) })
  },
}

export function translationAdapter(env: Env): ScriptAdapter | null {
  if (anthropicAdapter.status(env).configured) return anthropicAdapter
  if (env.PROVIDERS_MOCK === '1') return mockTranslator
  return null
}

const Reply = z.object({ items: z.array(z.object({ i: z.number().int(), text: z.string().max(600) })) })
const BATCH = 60

export async function translateSegments(
  adapter: ScriptAdapter,
  env: Env,
  segments: CaptionSegment[],
  target: TranslationLanguage,
): Promise<CaptionSegment[]> {
  const out: CaptionSegment[] = []
  for (let b = 0; b < segments.length; b += BATCH) {
    const batch = segments.slice(b, b + BATCH)
    const system =
      'Você traduz legendas de vídeo. Responda SOMENTE com JSON {"items":[{"i":número,"text":"tradução"}]} com exatamente os mesmos "i" recebidos, na mesma ordem. Traduza o sentido de forma natural e concisa para leitura em tela, preserve nomes próprios, números e marcas, não acrescente nem omita informação.'
    const payload = { items: batch.map((s, k) => ({ i: k, text: s.text })) }
    const prompt = `IDIOMA=${target} (${TRANSLATION_LANGUAGES[target]})\n${JSON.stringify(payload)}`
    const text = await adapter.complete({ system, prompt, maxTokens: Math.min(8000, 400 + batch.length * 120) }, env)
    const parsed = Reply.safeParse(extractJson(text))
    if (!parsed.success) throw new ProviderError('resposta de tradução fora do formato', 'remote', true)
    const byIndex = new Map(parsed.data.items.map((x) => [x.i, x.text.trim()]))
    if (batch.some((_, k) => !byIndex.get(k))) throw new ProviderError('tradução incompleta: faltaram legendas na resposta', 'remote', true)
    batch.forEach((s, k) => out.push({ ...s, text: byIndex.get(k)!, words: undefined }))
  }
  return out
}
