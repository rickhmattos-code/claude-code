import type { NextRequest } from 'next/server'

/**
 * Encaminha /api/* para a API. É um route handler (e não um rewrite do
 * next.config) porque rewrites ficam fixados no build: com ele, o endereço
 * interno da API (API_INTERNAL_URL) é lido em tempo de execução e a mesma
 * imagem serve para qualquer ambiente. Corpos e respostas são transmitidos
 * em fluxo (uploads multipart e downloads com Range).
 */
export const dynamic = 'force-dynamic'

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'expect']

async function proxy(req: NextRequest): Promise<Response> {
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:4000'
  const target = new URL(req.nextUrl.pathname + req.nextUrl.search, base)
  const headers = new Headers(req.headers)
  for (const h of HOP_BY_HOP) headers.delete(h)
  headers.set('x-forwarded-host', req.headers.get('host') ?? '')
  headers.set('x-forwarded-proto', req.nextUrl.protocol.replace(':', ''))
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, redirect: 'manual', cache: 'no-store' }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = req.body
    init.duplex = 'half'
  }
  let res: Response
  try {
    res = await fetch(target, init)
  } catch {
    return Response.json({ error: { code: 'api_unreachable', message: 'A API está indisponível no momento.' } }, { status: 502 })
  }
  const out = new Headers()
  res.headers.forEach((value, key) => {
    if (key === 'set-cookie' || HOP_BY_HOP.includes(key)) return
    // fetch já descompactou o corpo: o tamanho e a codificação originais não valem mais
    if (res.headers.has('content-encoding') && (key === 'content-encoding' || key === 'content-length')) return
    out.set(key, value)
  })
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c)
  return new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, statusText: res.statusText, headers: out })
}

export { proxy as DELETE, proxy as GET, proxy as HEAD, proxy as OPTIONS, proxy as PATCH, proxy as POST, proxy as PUT }
