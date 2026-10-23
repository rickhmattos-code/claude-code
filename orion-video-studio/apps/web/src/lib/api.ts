'use client'

/** Cliente HTTP da mesma origem (/api é encaminhado pelo Next à API). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path.startsWith('/api') ? path : `/api${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    })
  } catch {
    throw new ApiError(0, 'network', 'Sem conexão com o servidor. Verifique sua rede e tente novamente.')
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // resposta que não é JSON (ex.: página de erro de um proxy): nunca mostra o texto cru
    throw new ApiError(res.status, 'invalid_response', res.ok ? 'Resposta inesperada do servidor.' : fallbackMessage(res.status))
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error
    throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? fallbackMessage(res.status), e?.details)
  }
  return json as T
}

/** Mensagem em pt-BR quando o servidor não envia uma. */
export function fallbackMessage(status: number): string {
  if (status === 401) return 'Sessão expirada. Entre novamente.'
  if (status === 403) return 'Acesso negado.'
  if (status === 404) return 'Não encontrado.'
  if (status === 413) return 'Arquivo grande demais.'
  if (status === 429) return 'Muitas requisições. Aguarde alguns segundos e tente novamente.'
  if (status === 502 || status === 503 || status === 504) return 'Servidor indisponível no momento. Tente novamente em instantes.'
  if (status >= 500) return 'Erro no servidor. Tente novamente; se persistir, contate o suporte.'
  return `Não foi possível concluir a operação (erro ${status}).`
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.details)
      ? err.details
          .slice(0, 3)
          .map((d: { message?: string; path?: string }) => d.message ?? '')
          .filter(Boolean)
          .join(' · ')
      : ''
    return details ? `${err.message} ${details}` : err.message
  }
  return (err as Error)?.message ?? 'Erro inesperado.'
}

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)
