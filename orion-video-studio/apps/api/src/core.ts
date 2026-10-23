import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { PrismaClient, Role } from '@orion/db'
import type { Queues, Storage } from '@orion/server'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type IORedis from 'ioredis'
import { z, type ZodType } from 'zod'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  /** proxies cujo X-Forwarded-For é aceito (lista de IPs/CIDRs ou loopback, linklocal, uniquelocal) */
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  MAX_PROJECT_SECONDS: z.coerce.number().default(1800),
  MAX_UPLOAD_BYTES: z.coerce.number().default(4 * 1024 ** 3),
  DEFAULT_WORKSPACE_QUOTA_BYTES: z.coerce.number().default(20 * 1024 ** 3),
  DEFAULT_GENERATION_BUDGET_CENTS: z.coerce.number().default(2000),
  ALLOW_UNPRICED_GENERATION: z.string().default('0'),
  SESSION_DAYS: z.coerce.number().default(30),
  COOKIE_SECURE: z.string().default('0'),
  NODE_ENV: z.string().default('development'),
})
export type Config = z.infer<typeof ConfigSchema>

export interface Deps {
  db: PrismaClient
  storage: Storage
  queues: Queues
  redis: IORedis
  config: Config
  env: Record<string, string | undefined>
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

/** 404 com concordância: notFound('Projeto') → "Projeto não encontrado."; notFound('Mídia', 'f') → "Mídia não encontrada." */
export const notFound = (what = 'Recurso', gender: 'm' | 'f' = 'm') => new HttpError(404, 'not_found', `${what} não ${gender === 'f' ? 'encontrada' : 'encontrado'}.`)

export function parse<T>(schema: ZodType<T>, data: unknown, where = 'corpo'): T {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw new HttpError(400, 'validation', `Dados inválidos no ${where}.`, r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

// ---------------------------------------------------------------------------
// Senhas e sessões
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(pw, salt, 64, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem })
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export const SESSION_COOKIE = 'orion_session'
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export interface AuthUser {
  id: string
  email: string
  name: string
}

export async function currentUser(deps: Deps, req: FastifyRequest): Promise<AuthUser | null> {
  const token = req.cookies[SESSION_COOKIE]
  if (!token || token.length > 200) return null
  const session = await deps.db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } })
  if (!session || session.expiresAt < new Date()) return null
  return { id: session.user.id, email: session.user.email, name: session.user.name }
}

export async function startSession(deps: Deps, reply: FastifyReply, userId: string) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + deps.config.SESSION_DAYS * 86400_000)
  await deps.db.session.create({ data: { userId, tokenHash: sha256(token), expiresAt } })
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.config.COOKIE_SECURE === '1',
    path: '/',
    expires: expiresAt,
  })
}

// ---------------------------------------------------------------------------
// Autorização por workspace
// ---------------------------------------------------------------------------

const RANK: Record<Role, number> = { VIEWER: 0, EDITOR: 1, OWNER: 2 }

/** Lança 404 (não 403) para não revelar a existência de recursos de terceiros. */
export async function requireMember(deps: Deps, userId: string, workspaceId: string, min: Role = 'VIEWER') {
  const m = await deps.db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } })
  if (!m) throw notFound('Espaço de trabalho')
  if (RANK[m.role] < RANK[min]) throw new HttpError(403, 'forbidden', 'Seu papel neste espaço de trabalho não permite esta ação.')
  return m
}

// ---------------------------------------------------------------------------
// Registro de rotas (validação + documentação OpenAPI)
// ---------------------------------------------------------------------------

export interface RouteDoc {
  method: string
  url: string
  summary: string
  tag: string
  auth: boolean
  body?: ZodType
  query?: ZodType
}

export const routeDocs: RouteDoc[] = []

export interface Ctx<B, Q> {
  req: FastifyRequest
  reply: FastifyReply
  user: AuthUser
  body: B
  query: Q
  params: Record<string, string>
}

interface RouteOptions<B, Q> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  url: string
  summary: string
  tag: string
  body?: ZodType<B>
  query?: ZodType<Q>
  rateLimit?: { max: number; timeWindow: string }
  public?: boolean
}

export function route<B = undefined, Q = undefined>(
  app: FastifyInstance,
  deps: Deps,
  opts: RouteOptions<B, Q>,
  handler: (ctx: Ctx<B, Q>) => Promise<unknown>,
) {
  routeDocs.push({ method: opts.method, url: opts.url, summary: opts.summary, tag: opts.tag, auth: !opts.public, body: opts.body, query: opts.query })
  app.route({
    method: opts.method,
    url: opts.url,
    config: opts.rateLimit ? { rateLimit: opts.rateLimit } : {},
    handler: async (req, reply) => {
      let user: AuthUser | null = null
      if (!opts.public) {
        user = await currentUser(deps, req)
        if (!user) throw new HttpError(401, 'unauthenticated', 'Faça login para continuar.')
      }
      const body = opts.body ? parse(opts.body, req.body ?? {}) : (undefined as B)
      const query = opts.query ? parse(opts.query, req.query ?? {}, 'query') : (undefined as Q)
      const result = await handler({ req, reply, user: user as AuthUser, body, query, params: req.params as Record<string, string> })
      if (reply.sent) return reply
      return result ?? { ok: true }
    },
  })
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const r of routeDocs) {
    const path = r.url.replace(/:(\w+)/g, '{$1}')
    const params = [...r.url.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }))
    const op: Record<string, unknown> = {
      summary: r.summary,
      tags: [r.tag],
      parameters: params,
      responses: {
        '200': { description: 'Sucesso' },
        '400': { description: 'Dados inválidos', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        ...(r.auth ? { '401': { description: 'Não autenticado' }, '404': { description: 'Não encontrado ou sem acesso' } } : {}),
      },
      ...(r.auth ? { security: [{ cookieAuth: [] }] } : {}),
    }
    if (r.query) {
      const js = z.toJSONSchema(r.query, { unrepresentable: 'any' }) as { properties?: Record<string, unknown>; required?: string[] }
      for (const [name, schema] of Object.entries(js.properties ?? {})) {
        ;(op.parameters as unknown[]).push({ name, in: 'query', required: js.required?.includes(name) ?? false, schema })
      }
    }
    if (r.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: z.toJSONSchema(r.body, { unrepresentable: 'any', io: 'input' }) } } }
    }
    paths[path] ??= {}
    paths[path][r.method.toLowerCase()] = op
  }
  // rotas registradas fora do helper (autenticadas por assinatura, não por sessão)
  const tokenParam = [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }]
  paths['/api/storage/{token}'] = {
    put: { summary: 'Upload direto (driver local) com URL assinada; corpo binário. Partes multipart devolvem ETag.', tags: ['storage'], parameters: tokenParam, responses: { '200': { description: 'Recebido' }, '403': { description: 'Assinatura inválida/expirada' } } },
    get: { summary: 'Download/streaming (driver local) com URL assinada; suporta Range.', tags: ['storage'], parameters: tokenParam, responses: { '200': { description: 'Arquivo' }, '206': { description: 'Parcial' }, '403': { description: 'Assinatura inválida/expirada' } } },
  }
  paths['/api/webhooks/{provider}'] = {
    post: { summary: 'Webhook de provedor (HMAC-SHA256 em x-orion-signature sobre o JSON). Apenas agenda reconciliação.', tags: ['webhooks'], parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Aceito' }, '401': { description: 'Assinatura inválida' } } },
  }
  paths['/api/health'] = { get: { summary: 'Saúde (banco, Redis, armazenamento)', tags: ['ops'], responses: { '200': { description: 'OK' } } } }
  return {
    openapi: '3.1.0',
    info: { title: 'Orion Video Studio API', version: '0.1.0', description: 'API do ORION VIDEO STUDIO. Tempos em flicks (705.600.000 por segundo).' },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } },
      schemas: { Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } } },
    },
    paths,
  }
}
