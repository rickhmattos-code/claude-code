import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ProviderError } from './types.ts'

/** fetch com timeout e classificação de erros (quota, indisponível, inválido). */
export async function request(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  label: string,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 120_000)
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err) {
    throw new ProviderError(`${label}: falha de rede (${(err as Error).message})`, 'unavailable', true)
  } finally {
    clearTimeout(timer)
  }
  if (res.ok) return res
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 500)
  } catch {
    // ignora
  }
  // nunca inclui cabeçalhos/chaves na mensagem
  if (res.status === 429) throw new ProviderError(`${label}: limite de uso/quota atingido`, 'quota', true, 429)
  if (res.status === 401 || res.status === 403) throw new ProviderError(`${label}: credencial recusada pelo provedor`, 'config', false, res.status)
  if (res.status >= 500) throw new ProviderError(`${label}: provedor indisponível (${res.status})`, 'unavailable', true, res.status)
  throw new ProviderError(`${label}: requisição inválida (${res.status}) ${detail}`, 'invalid', false, res.status)
}

export async function downloadTo(res: Response, dst: string): Promise<void> {
  if (!res.body) throw new ProviderError('resposta sem corpo', 'remote', true)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dst))
}
