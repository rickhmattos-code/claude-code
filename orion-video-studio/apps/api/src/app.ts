import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { type Deps, HttpError, buildOpenApi } from './core.ts'
import { registerAssets } from './routes/assets.ts'
import { registerAuth } from './routes/auth.ts'
import { registerGenerations } from './routes/generations.ts'
import { registerLibrary } from './routes/library.ts'
import { registerProjects } from './routes/projects.ts'
import { registerRenders } from './routes/renders.ts'

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          // nunca registra cookies, cabeçalhos de autorização ou chaves
          redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers["xi-api-key"]', 'res.headers["set-cookie"]'],
        }
      : false,
    bodyLimit: 2 * 1024 * 1024 * 10,
    // só proxies conhecidos (a web e balanceadores internos); clientes diretos não forjam o IP
    trustProxy: deps.config.TRUST_PROXY.split(',').map((x) => x.trim()).filter(Boolean),
    // encerra conexões keep-alive ociosas ao desligar (shutdown limpo)
    forceCloseConnections: 'idle',
    // tokens de URL assinada são longos (payload + HMAC)
    routerOptions: { maxParamLength: 4096 },
  })
  await app.register(cookie)
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    redis: deps.redis,
    nameSpace: 'orion-rl:',
    errorResponseBuilder: () => ({ statusCode: 429, error: { code: 'rate_limited', message: 'Muitas requisições. Aguarde alguns segundos e tente novamente.' } }),
  })

  // proteção CSRF: requisições que alteram estado precisam vir da origem do app
  const allowed = new Set([deps.config.WEB_ORIGIN, deps.config.API_PUBLIC_URL])
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    if (req.url.startsWith('/api/storage/') || req.url.startsWith('/api/webhooks/')) return // autenticados por assinatura
    const origin = req.headers.origin
    if (origin && !allowed.has(origin)) throw new HttpError(403, 'bad_origin', 'Origem não permitida.')
  })
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'same-origin')
  })

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'route_not_found', message: `Endereço não encontrado: ${req.method} ${req.url.split('?')[0]}` } })
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } })
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'validation', message: 'Dados inválidos.', details: err.issues.slice(0, 20) } })
    }
    const e = err as { statusCode?: number; code?: string; message?: string }
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Muitas requisições. Aguarde e tente novamente.' } })
    if (e.statusCode && e.statusCode < 500) {
      // erros do próprio Fastify vêm em inglês: a mensagem exibida é sempre a nossa
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: clientErrorMessage(e.statusCode, e.code) } })
    }
    req.log.error({ err: { message: e.message, code: e.code } }, 'erro interno')
    return reply.code(500).send({ error: { code: 'internal', message: 'Erro interno. Tente novamente; se persistir, contate o suporte.' } })
  })

  registerAuth(app, deps)
  registerProjects(app, deps)
  registerAssets(app, deps)
  registerRenders(app, deps)
  registerGenerations(app, deps)
  registerLibrary(app, deps)

  app.get('/api/health', async () => {
    await deps.db.$queryRaw`SELECT 1`
    const redis = await deps.redis.ping()
    return { ok: true, db: 'ok', redis, storage: deps.storage.driver }
  })
  app.get('/api/openapi.json', async () => buildOpenApi())
  return app
}

/** Mensagem em pt-BR para erros 4xx gerados pelo Fastify e seus plugins. */
export function clientErrorMessage(status: number, code?: string): string {
  switch (code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return 'O conteúdo enviado é grande demais.'
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return 'Tipo de conteúdo não suportado.'
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return 'O corpo da requisição está vazio.'
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return 'O corpo da requisição é inválido.'
    case 'FST_ERR_VALIDATION':
      return 'Dados inválidos.'
  }
  if (status === 401) return 'Sessão expirada ou inválida. Entre novamente.'
  if (status === 403) return 'Acesso negado.'
  if (status === 404) return 'Não encontrado.'
  if (status === 405) return 'Método não permitido.'
  if (status === 413) return 'O conteúdo enviado é grande demais.'
  if (status === 415) return 'Tipo de conteúdo não suportado.'
  return 'Requisição inválida.'
}
