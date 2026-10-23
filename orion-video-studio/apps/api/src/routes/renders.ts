import type { Prisma } from '@orion/db'
import { audit } from '@orion/server'
import { CreateRenderBody, type TimelineDoc } from '@orion/shared'
import { validateDoc } from '@orion/timeline'
import type { FastifyInstance } from 'fastify'
import { type Deps, HttpError, notFound, requireMember, route } from '../core.ts'
import { renderDto } from '../dto.ts'
import { assetInfoMap, loadProject } from './projects.ts'

async function loadRender(deps: Deps, userId: string, id: string) {
  const r = await deps.db.renderJob.findUnique({ where: { id } })
  if (!r) throw notFound('Exportação', 'f')
  await requireMember(deps, userId, r.workspaceId).catch(() => {
    throw notFound('Exportação', 'f')
  })
  return r
}

export function registerRenders(app: FastifyInstance, deps: Deps) {
  route(app, deps, { method: 'POST', url: '/api/projects/:id/renders', summary: 'Exportar (cria revisão imutável e enfileira)', tag: 'renders', body: CreateRenderBody, rateLimit: { max: 20, timeWindow: '1 minute' } }, async ({ user, params, body, req }) => {
    const p = await loadProject(deps, user.id, params.id!, 'EDITOR')
    const existing = await deps.db.renderJob.findUnique({ where: { idempotencyKey: body.idempotencyKey } })
    if (existing) {
      if (existing.projectId !== p.id) throw new HttpError(409, 'idempotency_conflict', 'Chave de idempotência já usada em outro projeto.')
      return renderDto(existing)
    }
    const doc = p.document as unknown as TimelineDoc
    const { issues } = validateDoc(doc, { assets: await assetInfoMap(deps, doc), requireReadyAssets: true, maxDurationSeconds: deps.config.MAX_PROJECT_SECONDS })
    const errors = issues.filter((i) => i.severity === 'error')
    if (errors.length) throw new HttpError(422, 'project_invalid', 'Corrija os problemas do projeto antes de exportar.', errors)
    const job = await deps.db.$transaction(async (tx) => {
      const last = await tx.projectRevision.findFirst({ where: { projectId: p.id }, orderBy: { number: 'desc' }, select: { number: true } })
      const rev = await tx.projectRevision.create({
        data: { projectId: p.id, number: (last?.number ?? 0) + 1, document: doc as unknown as Prisma.InputJsonValue, docVersion: p.docVersion, reason: 'Exportação', createdById: user.id },
      })
      return tx.renderJob.create({
        data: { workspaceId: p.workspaceId, projectId: p.id, revisionId: rev.id, preset: body.preset as unknown as Prisma.InputJsonValue, idempotencyKey: body.idempotencyKey, createdById: user.id },
      })
    })
    await deps.queues.render.add('render', { renderJobId: job.id }, { jobId: `render-${job.id}` })
    await audit(deps.db, { workspaceId: p.workspaceId, userId: user.id, action: 'render.create', targetType: 'render', targetId: job.id, meta: { preset: body.preset }, ip: req.ip })
    return renderDto(job)
  })

  route(app, deps, { method: 'GET', url: '/api/renders/:id', summary: 'Status da exportação', tag: 'renders' }, async ({ user, params }) => {
    const r = await loadRender(deps, user.id, params.id!)
    const out: Record<string, unknown> = renderDto(r)
    if (r.status === 'succeeded' && r.outputAssetId) {
      const a = await deps.db.asset.findUnique({ where: { id: r.outputAssetId } })
      if (a) {
        out.downloadUrl = await deps.storage.presignGet(a.storageKey, 3600, `orion-${r.id.slice(0, 8)}.mp4`)
        out.previewUrl = await deps.storage.presignGet(a.storageKey, 3600)
      }
      if (r.captionsAssetId) {
        const c = await deps.db.asset.findUnique({ where: { id: r.captionsAssetId } })
        if (c) {
          out.srtUrl = await deps.storage.presignGet(c.storageKey, 3600, 'legendas.srt')
          out.vttUrl = await deps.storage.presignGet(c.storageKey.replace(/\.srt$/, '.vtt'), 3600, 'legendas.vtt')
        }
      }
    }
    return out
  })

  route(app, deps, { method: 'GET', url: '/api/projects/:id/renders', summary: 'Exportações do projeto', tag: 'renders' }, async ({ user, params }) => {
    const p = await loadProject(deps, user.id, params.id!)
    const rows = await deps.db.renderJob.findMany({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, take: 50 })
    return rows.map(renderDto)
  })

  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/renders', summary: 'Histórico de exportações', tag: 'renders' }, async ({ user, params }) => {
    await requireMember(deps, user.id, params.ws!)
    const rows = await deps.db.renderJob.findMany({ where: { workspaceId: params.ws! }, orderBy: { createdAt: 'desc' }, take: 100, include: { project: { select: { name: true } } } })
    return rows.map((r) => ({ ...renderDto(r), projectName: r.project.name }))
  })

  route(app, deps, { method: 'POST', url: '/api/renders/:id/cancel', summary: 'Cancelar exportação', tag: 'renders' }, async ({ user, params }) => {
    const r = await loadRender(deps, user.id, params.id!)
    await requireMember(deps, user.id, r.workspaceId, 'EDITOR')
    if (r.status === 'succeeded' || r.status === 'failed' || r.status === 'canceled') return renderDto(r)
    if (r.status === 'queued') {
      const job = await deps.queues.render.getJob(`render-${r.id}`)
      const state = await job?.getState()
      if (job && (state === 'waiting' || state === 'delayed')) {
        await job.remove()
        const upd = await deps.db.renderJob.update({ where: { id: r.id }, data: { status: 'canceled', cancelRequested: true, finishedAt: new Date() } })
        return renderDto(upd)
      }
    }
    const upd = await deps.db.renderJob.update({ where: { id: r.id }, data: { cancelRequested: true } })
    return renderDto(upd)
  })
}
