import { type AssistantBrief, Scene } from '@orion/shared'
import { StructuredCommand, estimateNarrationSeconds, scriptToScenes, secondsToFlicks } from '@orion/timeline'
import { z } from 'zod'
import type { Env, ScriptAdapter } from './types.ts'

/**
 * Assistente de criação. Duas fontes:
 *  - 'llm'   — Anthropic (quando configurado); saída JSON validada por schema.
 *  - 'local' — gerador ESTRUTURAL determinístico (sem IA): organiza o roteiro
 *    do usuário em cenas ou cria um esqueleto com marcadores [edite] para o
 *    usuário preencher. Nunca é apresentado como texto gerado por IA.
 */

export const CreativePlan = z.object({
  source: z.enum(['llm', 'local']),
  openings: z.array(z.string().min(1).max(300)).length(3),
  script: z.string().min(1).max(40000),
  scenes: z.array(Scene).min(1).max(500),
  musicSuggestions: z.array(z.object({ mood: z.string(), reason: z.string() })).max(5),
  cta: z.string().max(300),
  estimatedSeconds: z.number(),
  notes: z.array(z.string()).max(10),
})
export type CreativePlan = z.infer<typeof CreativePlan>

const TONE_TO_MOOD: Array<[RegExp, string]> = [
  [/reflex|calm|filos|sereno|inspira/i, 'contemplativo'],
  [/energ|vend|urg|motiv/i, 'energético'],
  [/institu|corpor|profiss/i, 'inspirador'],
  [/hist|drama|épic|cinema/i, 'cinematográfico'],
  [/educ|didát|leve|simples/i, 'leve'],
  [/humor|divert|engra/i, 'divertido'],
]

function musicFor(tone: string): CreativePlan['musicSuggestions'] {
  const hits = TONE_TO_MOOD.filter(([r]) => r.test(tone)).map(([, m]) => m)
  const moods = hits.length ? hits : ['inspirador']
  return moods.slice(0, 2).map((mood) => ({ mood, reason: `Combina com o tom "${tone}".` }))
}

export function localPlan(brief: AssistantBrief, maxSceneSeconds: number): CreativePlan {
  const theme = brief.theme.trim().replace(/[.!?]+$/, '')
  const openings = [
    `Você já parou para pensar em ${theme.toLowerCase()}?`,
    `Quase ninguém fala sobre isto: ${theme.toLowerCase()}.`,
    `Em ${Math.round(brief.durationSeconds / 60) || 1} minuto${brief.durationSeconds >= 120 ? 's' : ''}, você vai entender ${theme.toLowerCase()}.`,
  ]
  const notes: string[] = []
  let script: string
  if (brief.script?.trim()) {
    script = brief.script.trim()
    notes.push('Roteiro fornecido por você, organizado em cenas automaticamente (sem alteração do texto).')
  } else {
    const points = Math.max(2, Math.min(8, Math.round(brief.durationSeconds / 25)))
    const body = Array.from({ length: points }, (_, i) => `[edite] Ponto ${i + 1} sobre ${theme.toLowerCase()} para ${brief.audience || 'seu público'}: explique com um exemplo concreto.`)
    script = [openings[0], ...body, `[edite] Conclusão: o que ${brief.audience || 'o público'} deve lembrar. ${brief.goal ? `Objetivo: ${brief.goal}.` : ''}`].join('\n\n')
    notes.push('Rascunho ESTRUTURAL gerado localmente (sem IA). Substitua os trechos [edite] antes de gerar narração.')
    notes.push('Configure ANTHROPIC_API_KEY para gerar roteiro completo com IA.')
  }
  const scenes = scriptToScenes(script, { maxSceneSeconds, visualStyle: brief.visualStyle || 'Visual limpo e cinematográfico' })
  const est = scenes.reduce((a, s) => a + s.estimatedDuration, 0) / 705_600_000
  if (Math.abs(est - brief.durationSeconds) > brief.durationSeconds * 0.25) {
    notes.push(`Duração estimada da narração (${Math.round(est)} s) difere da meta (${brief.durationSeconds} s): ajuste o texto ou complete com material de apoio.`)
  }
  return {
    source: 'local',
    openings,
    script,
    scenes,
    musicSuggestions: musicFor(brief.tone),
    cta: brief.goal ? `${brief.goal} — comente ou toque no link.` : 'Siga para mais conteúdos como este.',
    estimatedSeconds: Math.round(est),
    notes,
  }
}

const LlmPlanShape = z.object({
  openings: z.array(z.string()).length(3),
  script: z.string(),
  cta: z.string(),
  visualPrompts: z.array(z.string()).optional(),
})

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('resposta sem JSON')
  return JSON.parse(text.slice(start, end + 1))
}

export async function llmPlan(adapter: ScriptAdapter, env: Env, brief: AssistantBrief, maxSceneSeconds: number): Promise<CreativePlan> {
  const words = Math.round(brief.durationSeconds * 2.5)
  const system =
    'Você é roteirista de vídeos curtos e longos em português do Brasil. Responda SOMENTE com JSON válido no formato {"openings":[3 strings],"script":"parágrafos separados por linha em branco, cada parágrafo é uma cena","cta":"string"}. Não invente dados, números ou citações; quando faltar informação, escreva de forma geral.'
  const prompt = `Tema: ${brief.theme}\nPúblico: ${brief.audience}\nObjetivo: ${brief.goal}\nTom: ${brief.tone}\nEstilo visual: ${brief.visualStyle}\nDuração alvo: ${brief.durationSeconds} s (~${words} palavras de narração)\nReferências: ${brief.references ?? 'nenhuma'}\n${brief.script ? `Roteiro base do usuário (preserve as ideias):\n${brief.script}` : ''}`
  const text = await adapter.complete({ system, prompt, maxTokens: Math.min(8000, Math.max(1500, words * 3)) }, env)
  const parsed = LlmPlanShape.parse(extractJson(text))
  const scenes = scriptToScenes(parsed.script, { maxSceneSeconds, visualStyle: brief.visualStyle || 'Visual limpo e cinematográfico' })
  const est = scenes.reduce((a, s) => a + s.estimatedDuration, 0) / 705_600_000
  return CreativePlan.parse({
    source: 'llm',
    openings: parsed.openings,
    script: parsed.script,
    scenes,
    musicSuggestions: musicFor(brief.tone),
    cta: parsed.cta,
    estimatedSeconds: Math.round(est),
    notes: ['Roteiro gerado por IA: revise fatos e tom antes de aprovar.'],
  })
}

/** Converte instrução livre em comandos estruturados via LLM (validados). */
export async function llmCommand(
  adapter: ScriptAdapter,
  env: Env,
  command: string,
  summary: string,
): Promise<StructuredCommand[]> {
  const system =
    'Converta a instrução do usuário em uma lista JSON de comandos para um editor de vídeo. Tipos permitidos: split{clipId,at}, trim{clipId,edge,time}, delete{clipIds,ripple}, duplicate{clipId}, speed{clipId,speed}, trackVolume{trackKind,factor}, shortenIntro{seconds}. Tempos em flicks (705600000 por segundo). Use apenas IDs presentes no resumo. Responda SOMENTE {"commands":[...]}.'
  const text = await adapter.complete({ system, prompt: `Projeto:\n${summary}\n\nInstrução: ${command}`, maxTokens: 1500 }, env)
  const json = extractJson(text) as { commands?: unknown[] }
  return z.array(StructuredCommand).max(20).parse(json.commands ?? [])
}

export function narrationSecondsForScenes(scenes: Scene[]): number {
  return scenes.reduce((a, s) => a + estimateNarrationSeconds(s.narration), 0)
}

export const flicks = secondsToFlicks
