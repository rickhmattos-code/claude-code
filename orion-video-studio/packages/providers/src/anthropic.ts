import type { ProviderStatus } from '@orion/shared'
import { request } from './http.ts'
import { type Env, ProviderError, type ScriptAdapter, missing } from './types.ts'

/**
 * Anthropic Messages API para roteiro, storyboard e interpretação de
 * comandos do assistente. A saída é sempre JSON validado por schema antes
 * de ser usada (packages/providers/src/assistant.ts).
 *  POST https://api.anthropic.com/v1/messages
 *  cabeçalhos x-api-key, anthropic-version: 2023-06-01
 */

export const anthropicAdapter: ScriptAdapter = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  status(env: Env): ProviderStatus {
    const miss = missing(env, ['ANTHROPIC_API_KEY'])
    return {
      id: 'anthropic',
      label: 'Anthropic Claude',
      kinds: ['SCRIPT'],
      configured: !miss.length,
      mode: miss.length ? 'pending-config' : 'live',
      missingEnv: miss,
      notes: `Roteiro, aberturas e comandos em linguagem natural (modelo: ${env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'}). Sem chave, o assistente usa o gerador estrutural local.`,
    }
  },
  async complete(input, env) {
    const key = env.ANTHROPIC_API_KEY
    if (!key) throw new ProviderError('ANTHROPIC_API_KEY ausente', 'config', false)
    const res = await request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
          max_tokens: input.maxTokens,
          system: input.system,
          messages: [{ role: 'user', content: input.prompt }],
        }),
        timeoutMs: 180_000,
      },
      'Anthropic',
    )
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
    if (!text) throw new ProviderError('resposta vazia', 'remote', true)
    return text
  },
}
