import type { Prisma } from '@orion/db'
import { toNum } from '@orion/db'
import { assertAssetsInWorkspace, audit, referencedAssetIds, syncTimelineProjection } from '@orion/server'
import { CreateProjectBody, CreateRevisionBody, SaveProjectBody, TemplateDefinition, type TimelineDoc } from '@orion/shared'
import { type AssetInfo, applyTemplate, createDocument, docDuration, toSrt, toVtt, validateDoc } from '@orion/timeline'
import type { FastifyInstance } from 'fastify'
import { type Deps, HttpError, notFound, requireMember, route } from '../core.ts'

const AUTO_REVISION_MS = 10 * 60 * 1000
const MAX_AUTO_REVISIONS = 50

export async function loadProject(deps: Deps, userId: string, id: string, min: 'VIEWER' | 'EDITOR' | 'OWNER' = 'VIEWER') {
  const p = await deps.db.project.findFirst({ where: { id, deletedAt: null } })
  if (!p) throw notFound('Projeto')
  await requireMember(deps, userId, p.workspaceId, min).catch(() => {
    throw notFound('Projeto')
  })
  return p
}

export async function assetInfoMap(deps: Deps, doc: TimelineDoc): Promise<Map<string, AssetInfo>> {
  const ids = referencedAssetIds(doc)
  const rows = await deps.db.asset.findMany({ where: { id: { in: ids } } })
  return new Map(
    rows.map((a) => [a.id, { id: a.id, kind: a.kind, status: a.status, durationFlicks: toNum(a.durationFlicks), hasAudio: a.hasAudio, hasVideo: a.hasVideo }]),
  )
}

async function createRevision(tx: Prisma.TransactionClient, projectId: string, document: unknown, docVersion: number, reason: string, userId: string) {
  const last = await tx.projectRevision.findFirst({ where: { projectId }, orderBy: { number: 'desc' }, select: { number: true } })
  return tx.projectRevision.create({
    data: { projectId, number: (last?.number ?? 0) + 1, document: document as Prisma.InputJsonValue, docVersion, reason, createdById: userId },
  })
}

export function registerProjects(app: FastifyInstance, deps: Deps) {
  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/projects', summary: 'Listar projetos', tag: 'projects' }, async ({ user, params }) => {
    await requireMember(deps, user.id, params.ws!)
    const rows = await deps.db.project.findMany({
      where: { workspaceId: params.ws!, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, updatedAt: true, createdAt: true, document: true, timeline: { select: { durationFlicks: true } } },
    })
    return rows.map((r) => {
      const doc = r.document as unknown as TimelineDoc
      return { id: r.id, name: r.name, updatedAt: r.updatedAt.toISOString(), createdAt: r.createdAt.toISOString(), aspect: doc.settings?.aspect, durationFlicks: toNum(r.timeline?.durationFlicks) ?? 0 }
    })
  })

  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/projects', summary: 'Criar projeto (vazio ou a partir de template)', tag: 'projects', body: CreateProjectBody }, async ({ user, params, body, req }) => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    let doc: TimelineDoc
    const settings = { aspect: body.aspect, ...(body.width ? { width: body.width } : {}), ...(body.height ? { height: body.height } : {}), ...(body.fps ? { fps: body.fps } : {}) }
    if (body.templateId) {
      const t = await deps.db.template.findFirst({ where: { id: body.templateId, OR: [{ workspaceId: null }, { workspaceId: params.ws! }] } })
      if (!t) throw notFound('Template')
      doc = applyTemplate({ template: TemplateDefinition.parse(t.definition), settings, textValues: body.fieldValues })
    } else {
      doc = createDocument(settings)
    }
    const { issues } = validateDoc(doc)
    if (issues.some((i) => i.code === 'schema')) throw new HttpError(400, 'invalid_document', 'Configuração de projeto inválida.', issues)
    const project = await deps.db.$transaction(async (tx) => {
      const p = await tx.project.create({ data: { workspaceId: params.ws!, name: body.name, document: doc as unknown as Prisma.InputJsonValue, createdById: user.id } })
      await syncTimelineProjection(tx, p.id, doc, 1, docDuration(doc))
      await createRevision(tx, p.id, doc, 1, body.templateId ? 'Criado a partir de template' : 'Criação', user.id)
      await audit(tx, { workspaceId: params.ws, userId: user.id, action: 'project.create', targetType: 'project', targetId: p.id, ip: req.ip })
      return p
    })
    return { id: project.id, name: project.name, docVersion: 1, document: doc }
  })

  route(app, deps, { method: 'GET', url: '/api/projects/:id', summary: 'Abrir projeto', tag: 'projects' }, async ({ user, params }) => {
    const p = await loadProject(deps, user.id, params.id!)
    const m = await requireMember(deps, user.id, p.workspaceId)
    return { id: p.id, workspaceId: p.workspaceId, name: p.name, document: p.document, docVersion: p.docVersion, updatedAt: p.updatedAt.toISOString(), role: m.role }
  })

  route(app, deps, { method: 'PUT', url: '/api/projects/:id', summary: 'Salvar projeto (concorrência otimista)', tag: 'projects', body: SaveProjectBody }, async ({ user, params, body }) => {
    const p = await loadProject(deps, user.id, params.id!, 'EDITOR')
    const { doc, issues } = validateDoc(body.document, { maxDurationSeconds: deps.config.MAX_PROJECT_SECONDS })
    if (!doc) throw new HttpError(400, 'invalid_document', 'Documento inválido.', issues)
    const foreign = await assertAssetsInWorkspace(deps.db, p.workspaceId, doc)
    if (foreign.length) throw new HttpError(400, 'foreign_assets', 'O projeto referencia mídias que não pertencem a este workspace.', foreign)
    const newVersion = body.baseVersion + 1
    const result = await deps.db.$transaction(async (tx) => {
      const upd = await tx.project.updateMany({
        where: { id: p.id, docVersion: body.baseVersion, deletedAt: null },
        data: { document: doc as unknown as Prisma.InputJsonValue, docVersion: newVersion, ...(body.name ? { name: body.name } : {}) },
      })
      if (upd.count === 0) return null
      await syncTimelineProjection(tx, p.id, doc, newVersion, docDuration(doc))
      const last = await tx.projectRevision.findFirst({ where: { projectId: p.id }, orderBy: { number: 'desc' }, select: { createdAt: true } })
      if (!last || Date.now() - last.createdAt.getTime() > AUTO_REVISION_MS) {
        await createRevision(tx, p.id, doc, newVersion, 'Automático', user.id)
        const autos = await tx.projectRevision.findMany({ where: { projectId: p.id, reason: 'Automático', renderJobs: { none: {} } }, orderBy: { number: 'desc' }, skip: MAX_AUTO_REVISIONS, select: { id: true } })
        if (autos.length) await tx.projectRevision.deleteMany({ where: { id: { in: autos.map((a) => a.id) } } })
      }
      return newVersion
    })
    if (result === null) {
      const current = await deps.db.project.findUnique({ where: { id: p.id }, select: { docVersion: true } })
      throw new HttpError(409, 'version_conflict', 'O projeto foi alterado em outra sessão. Recarregue para continuar.', { currentVersion: current?.docVersion })
    }
    return { docVersion: result, warnings: issues.filter((i) => i.severity !== 'error' || i.code !== 'schema') }
  })

  route(app, deps, { method: 'DELETE', url: '/api/projects/:id', summary: 'Excluir projeto (lógico)', tag: 'projects' }, async ({ user, params, req }) => {
    const p = await loadProject(deps, user.id, params.id!, 'EDITOR')
    await deps.db.project.update({ where: { id: p.id }, data: { deletedAt: new Date() } })
    // remove a projeção para liberar ativos à coleta de lixo
    await deps.db.timeline.deleteMany({ where: { projectId: p.id } })
    await audit(deps.db, { workspaceId: p.workspaceId, userId: user.id, action: 'project.delete', targetType: 'project', targetId: p.id, ip: req.ip })
    return { ok: true }
  })

  route(app, deps, { method: 'POST', url: '/api/projects/:id/validate', summary: 'Validar projeto para exportação', tag: 'projects' }, async ({ user, params }) => {
    const p = await loadProject(deps, user.id, params.id!)
    const doc = p.document as unknown as TimelineDoc
    const { issues } = validateDoc(doc, { assets: await assetInfoMap(deps, doc), requireReadyAssets: true, maxDurationSeconds: deps.config.MAX_PROJECT_SECONDS })
    return { issues, durationFlicks: docDuration(doc) }
  })

  route(app, deps, { method: 'GET', url: '/api/projects/:id/revisions', summary: 'Histórico de versões', tag: 'projects' }, async ({ user, params }) => {
    const p = await loadProject(deps, user.id, params.id!)
    const revs = await deps.db.projectRevision.findMany({ where: { projectId: p.id }, orderBy: { number: 'desc' }, select: { id: true, number: true, reason: true, createdAt: true, docVersion: true } })
    return revs.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
  })

  route(app, deps, { method: 'POST', url: '/api/projects/:id/revisions', summary: 'Criar versão nomeada', tag: 'projects', body: CreateRevisionBody }, async ({ user, params, body }) => {
    const p = await loadProject(deps, user.id, params.id!, 'EDITOR')
    const rev = await deps.db.$transaction((tx) => createRevision(tx, p.id, p.document, p.docVersion, body.reason, user.id))
    return { id: rev.id, number: rev.number }
  })

  route(app, deps, { method: 'GET', url: '/api/projects/:id/revisions/:revId', summary: 'Ler versão', tag: 'projects' }, async ({ user, params }) => {
    const p = await loadProject(deps, user.id, params.id!)
    const rev = await deps.db.projectRevision.findFirst({ where: { id: params.revId!, projectId: p.id } })
    if (!rev) throw notFound('Versão')
    return { id: rev.id, number: rev.number, reason: rev.reason, document: rev.document, createdAt: rev.createdAt.toISOString() }
  })

  route(app, deps, { method: 'POST', url: '/api/projects/:id/revisions/:revId/restore', summary: 'Restaurar versão', tag: 'projects' }, async ({ user, params }) => {
    const p = await loadProject(deps, user.id, params.id!, 'EDITOR')
    const rev = await deps.db.projectRevision.findFirst({ where: { id: params.revId!, projectId: p.id } })
    if (!rev) throw notFound('Versão')
    const doc = rev.document as unknown as TimelineDoc
    const newVersion = p.docVersion + 1
    await deps.db.$transaction(async (tx) => {
      await createRevision(tx, p.id, p.document, p.docVersion, `Antes de restaurar v${rev.number}`, user.id)
      await tx.project.update({ where: { id: p.id }, data: { document: doc as unknown as Prisma.InputJsonValue, docVersion: newVersion } })
      await syncTimelineProjection(tx, p.id, doc, newVersion, docDuration(doc))
    })
    return { docVersion: newVersion, document: doc }
  })

  for (const fmt of ['srt', 'vtt'] as const) {
    route(app, deps, { method: 'GET', url: `/api/projects/:id/captions.${fmt}`, summary: `Exportar legendas ${fmt.toUpperCase()}`, tag: 'captions' }, async ({ user, params, reply }) => {
      const p = await loadProject(deps, user.id, params.id!)
      const doc = p.document as unknown as TimelineDoc
      const text = fmt === 'srt' ? toSrt(doc.captions.segments) : toVtt(doc.captions.segments)
      reply
        .header('content-type', fmt === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8')
        .header('content-disposition', `attachment; filename="legendas.${fmt}"`)
        .send(text)
    })
  }
}
