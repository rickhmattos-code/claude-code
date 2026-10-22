import { LoginBody, RegisterBody } from '@orion/shared'
import { audit } from '@orion/server'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type Deps, HttpError, SESSION_COOKIE, currentUser, hashPassword, requireMember, route, sha256, startSession, verifyPassword } from '../core.ts'

export function registerAuth(app: FastifyInstance, deps: Deps) {
  const strict = { max: 10, timeWindow: '1 minute' }

  route(app, deps, { method: 'POST', url: '/api/auth/register', summary: 'Criar conta (cria workspace pessoal)', tag: 'auth', body: RegisterBody, public: true, rateLimit: strict }, async ({ body, reply, req }) => {
    const email = body.email.toLowerCase().trim()
    const exists = await deps.db.user.findUnique({ where: { email } })
    if (exists) throw new HttpError(409, 'email_taken', 'Este e-mail já está cadastrado.')
    const passwordHash = await hashPassword(body.password)
    const user = await deps.db.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email, name: body.name, passwordHash } })
      const ws = await tx.workspace.create({
        data: { name: `Estúdio de ${body.name}`, quotaBytes: BigInt(deps.config.DEFAULT_WORKSPACE_QUOTA_BYTES), generationBudgetCents: deps.config.DEFAULT_GENERATION_BUDGET_CENTS },
      })
      await tx.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: 'OWNER' } })
      await audit(tx, { workspaceId: ws.id, userId: u.id, action: 'user.register', targetType: 'user', targetId: u.id, ip: req.ip })
      return u
    })
    await startSession(deps, reply, user.id)
    return { id: user.id, email: user.email, name: user.name }
  })

  route(app, deps, { method: 'POST', url: '/api/auth/login', summary: 'Entrar', tag: 'auth', body: LoginBody, public: true, rateLimit: strict }, async ({ body, reply, req }) => {
    const user = await deps.db.user.findUnique({ where: { email: body.email.toLowerCase().trim() } })
    // compara mesmo quando o usuário não existe (tempo constante aproximado)
    const ok = await verifyPassword(body.password, user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA')
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'E-mail ou senha incorretos.')
    await startSession(deps, reply, user.id)
    await audit(deps.db, { userId: user.id, action: 'user.login', targetType: 'user', targetId: user.id, ip: req.ip })
    return { id: user.id, email: user.email, name: user.name }
  })

  route(app, deps, { method: 'POST', url: '/api/auth/logout', summary: 'Sair', tag: 'auth', public: true }, async ({ req, reply }) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) await deps.db.session.deleteMany({ where: { tokenHash: sha256(token) } })
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  route(app, deps, { method: 'GET', url: '/api/auth/me', summary: 'Usuário atual e workspaces', tag: 'auth', public: true }, async ({ req }) => {
    const user = await currentUser(deps, req)
    if (!user) return { user: null, workspaces: [] }
    const memberships = await deps.db.membership.findMany({ where: { userId: user.id }, include: { workspace: true }, orderBy: { createdAt: 'asc' } })
    return {
      user,
      workspaces: memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role, plan: m.workspace.plan })),
    }
  })

  route(
    app,
    deps,
    { method: 'POST', url: '/api/workspaces/:ws/members', summary: 'Adicionar membro existente ao workspace', tag: 'auth', body: z.object({ email: z.string().email(), role: z.enum(['EDITOR', 'VIEWER']) }) },
    async ({ user, params, body, req }) => {
      await requireMember(deps, user.id, params.ws!, 'OWNER')
      const target = await deps.db.user.findUnique({ where: { email: body.email.toLowerCase() } })
      if (!target) throw new HttpError(404, 'not_found', 'Usuário não encontrado. Peça que crie uma conta primeiro.')
      await deps.db.membership.upsert({
        where: { userId_workspaceId: { userId: target.id, workspaceId: params.ws! } },
        create: { userId: target.id, workspaceId: params.ws!, role: body.role },
        update: { role: body.role },
      })
      await audit(deps.db, { workspaceId: params.ws, userId: user.id, action: 'member.add', targetType: 'user', targetId: target.id, ip: req.ip })
      return { ok: true }
    },
  )
}
