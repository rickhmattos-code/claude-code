import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalStorage, type MaintenanceJob } from '@orion/server'
import type { WorkerContext } from '../context.ts'

/**
 * Manutenção periódica:
 *  - cleanup: uploads expirados, partes multipart abandonadas, temporários antigos;
 *  - gc: remove fisicamente ativos excluídos há mais de ASSET_RETENTION_DAYS que
 *    não têm referências (Clip, personagem, música) e exportações antigas;
 *  - reconcile: reenfileira jobs "running" sem job ativo na fila (queda de worker).
 */
export async function runMaintenance(ctx: WorkerContext, job: MaintenanceJob) {
  if (job.type === 'cleanup') return cleanup(ctx)
  if (job.type === 'gc') return gc(ctx)
  return reconcile(ctx)
}

async function cleanup(ctx: WorkerContext) {
  const expired = await ctx.db.upload.findMany({ where: { status: 'CREATED', expiresAt: { lt: new Date() } }, take: 200 })
  for (const up of expired) {
    if (up.mode === 'MULTIPART' && up.s3UploadId) await ctx.storage.abortMultipart(up.storageKey, up.s3UploadId).catch(() => undefined)
    await ctx.storage.remove(up.storageKey).catch(() => undefined)
    await ctx.db.upload.update({ where: { id: up.id }, data: { status: 'EXPIRED' } })
    await ctx.db.asset.update({ where: { id: up.assetId }, data: { status: 'FAILED', error: 'Upload expirado', deletedAt: new Date() } })
  }
  if (ctx.storage instanceof LocalStorage) {
    for (const dir of await ctx.storage.listStaleParts(24 * 3600_000)) await rm(dir, { recursive: true, force: true })
  }
  // temporários de jobs com mais de 24 h sem modificação
  for (const sub of ['media', 'gen', 'render']) {
    const base = join(ctx.tmpDir, sub)
    const entries = await readdir(base).catch(() => [] as string[])
    for (const e of entries) {
      const p = join(base, e)
      const s = await stat(p).catch(() => null)
      if (!s) continue
      if (sub === 'render') {
        const r = await ctx.db.renderJob.findUnique({ where: { id: e }, select: { status: true } })
        if (r && (r.status === 'running' || r.status === 'queued')) continue
      }
      if (Date.now() - s.mtimeMs > 24 * 3600_000) await rm(p, { recursive: true, force: true })
    }
  }
  return { expiredUploads: expired.length }
}

async function gc(ctx: WorkerContext) {
  const days = Number(ctx.env.ASSET_RETENTION_DAYS ?? 7)
  const cutoff = new Date(Date.now() - days * 86400_000)
  const candidates = await ctx.db.asset.findMany({ where: { deletedAt: { lt: cutoff } }, take: 200 })
  let removed = 0
  for (const a of candidates) {
    const refs = (await ctx.db.clip.count({ where: { assetId: a.id } })) + (await ctx.db.characterReference.count({ where: { assetId: a.id } })) + (await ctx.db.musicTrack.count({ where: { assetId: a.id } }))
    if (refs > 0) continue
    for (const key of [a.storageKey, a.thumbnailKey, a.waveformKey, a.proxyKey, a.proxyKey?.replace(/proxy\.(mp4|m4a)$/, 'proxy.webm')]) if (key) await ctx.storage.remove(key).catch(() => undefined)
    await ctx.db.asset.delete({ where: { id: a.id } }).catch(() => undefined)
    removed++
  }
  // exportações antigas: o arquivo expira, o registro do job permanece (histórico)
  const renderDays = Number(ctx.env.RENDER_RETENTION_DAYS ?? 30)
  const oldRenders = await ctx.db.renderJob.findMany({ where: { status: 'succeeded', finishedAt: { lt: new Date(Date.now() - renderDays * 86400_000) }, outputAssetId: { not: null } }, take: 100 })
  for (const r of oldRenders) {
    await ctx.db.asset.updateMany({ where: { id: { in: [r.outputAssetId!, ...(r.captionsAssetId ? [r.captionsAssetId] : [])] } }, data: { deletedAt: new Date(Date.now() - (days + 1) * 86400_000) } })
    await ctx.db.renderJob.update({ where: { id: r.id }, data: { outputAssetId: null, captionsAssetId: null, stage: 'arquivo expirado (retenção)' } })
  }
  return { removed, expiredRenders: oldRenders.length }
}

async function reconcile(ctx: WorkerContext) {
  let requeued = 0
  const running = await ctx.db.renderJob.findMany({ where: { status: { in: ['running', 'queued'] } }, take: 100 })
  for (const r of running) {
    const job = await ctx.queues.render.getJob(`render-${r.id}`)
    const state = await job?.getState()
    if (!job || state === 'completed' || state === 'failed' || state === 'unknown') {
      if (job) await job.remove().catch(() => undefined)
      await ctx.queues.render.add('render', { renderJobId: r.id }, { jobId: `render-${r.id}` })
      requeued++
    }
  }
  const gens = await ctx.db.generationJob.findMany({ where: { status: 'running', kind: 'VIDEO', remoteId: { not: null }, updatedAt: { lt: new Date(Date.now() - 2 * 60_000) } }, take: 100 })
  for (const g of gens) {
    await ctx.queues.generation.add('poll', { generationJobId: g.id, phase: 'poll' }, { jobId: `gen-${g.id}-reconcile-${Date.now()}` })
    requeued++
  }
  return { requeued }
}
