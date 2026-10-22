import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Prisma } from '@orion/db'
import { toNum } from '@orion/db'
import { FfmpegError, renderProject, type SourceAsset } from '@orion/media'
import { objectKey, referencedAssetIds } from '@orion/server'
import { RenderPreset, type TimelineDoc } from '@orion/shared'
import { validateDoc } from '@orion/timeline'
import type { WorkerContext } from '../context.ts'

/**
 * Execução de uma exportação. Lê a REVISÃO imutável (não o projeto atual),
 * então editar durante a exportação não altera o resultado. O diretório de
 * trabalho é estável por job: numa nova tentativa (falha/queda do worker)
 * normalizações, blocos e stems já prontos são reaproveitados.
 */

export class RenderCanceled extends Error {}

export async function runRenderJob(ctx: WorkerContext, renderJobId: string, attempt: number, maxAttempts: number) {
  const job = await ctx.db.renderJob.findUnique({ where: { id: renderJobId }, include: { revision: true } })
  if (!job) return
  if (job.status === 'succeeded' || job.status === 'canceled') return
  if (job.cancelRequested) {
    await ctx.db.renderJob.update({ where: { id: job.id }, data: { status: 'canceled', finishedAt: new Date() } })
    return
  }
  const workDir = join(ctx.tmpDir, 'render', job.id)
  await mkdir(workDir, { recursive: true })
  await ctx.db.renderJob.update({ where: { id: job.id }, data: { status: 'running', startedAt: job.startedAt ?? new Date(), attempts: { increment: 1 }, error: null } })

  const controller = new AbortController()
  const cancelPoll = setInterval(async () => {
    try {
      const r = await ctx.db.renderJob.findUnique({ where: { id: job.id }, select: { cancelRequested: true } })
      if (r?.cancelRequested) controller.abort(new RenderCanceled('cancelado'))
    } catch {
      // ignora falha transitória
    }
  }, 2000)
  let lastWrite = 0
  const stageWeights = { normalize: [0, 0.1], video: [0.1, 0.8], audio: [0.8, 0.93], mux: [0.93, 0.96], validate: [0.96, 1] } as const

  try {
    const doc = job.revision.document as unknown as TimelineDoc
    const preset = RenderPreset.parse(job.preset)
    const ids = referencedAssetIds(doc)
    const rows = await ctx.db.asset.findMany({ where: { id: { in: ids } } })
    const infoMap = new Map(rows.map((a) => [a.id, { id: a.id, kind: a.kind, status: a.status, durationFlicks: toNum(a.durationFlicks), hasAudio: a.hasAudio, hasVideo: a.hasVideo }]))
    const { issues } = validateDoc(doc, { assets: infoMap, requireReadyAssets: true, maxDurationSeconds: Number(ctx.env.MAX_PROJECT_SECONDS ?? 1800) })
    const errors = issues.filter((i) => i.severity === 'error')
    if (errors.length) throw new Error(`Projeto inválido: ${errors.map((e) => e.message).join('; ')}`)

    // 3. resolução dos ativos (download para cache local do job)
    const assets = new Map<string, SourceAsset>()
    const cacheDir = join(workDir, 'assets')
    await mkdir(cacheDir, { recursive: true })
    for (const a of rows) {
      const ext = a.storageKey.slice(a.storageKey.lastIndexOf('.'))
      const local = join(cacheDir, `${a.id}${ext}`)
      const have = await stat(local).then((s) => s.size === Number(a.sizeBytes)).catch(() => false)
      if (!have) await ctx.storage.download(a.storageKey, local)
      assets.set(a.id, { id: a.id, kind: a.kind as SourceAsset['kind'], path: local, width: a.width, height: a.height, durationFlicks: toNum(a.durationFlicks), hasAudio: a.hasAudio })
    }

    const result = await renderProject({
      doc,
      preset,
      workDir,
      assets,
      fonts: ctx.fonts,
      signal: controller.signal,
      chunkSeconds: Number(ctx.env.RENDER_CHUNK_SECONDS ?? 30),
      x264Preset: ctx.env.RENDER_X264_PRESET ?? 'veryfast',
      crf: Number(ctx.env.RENDER_CRF ?? 20),
      onProgress: (p) => {
        const [a, b] = stageWeights[p.stage]
        const progress = a + (b - a) * p.progress
        const now = Date.now()
        if (now - lastWrite < 1000 && p.progress < 1) return
        lastWrite = now
        void ctx.db.renderJob.update({ where: { id: job.id }, data: { progress, stage: p.detail ? `${p.stage}: ${p.detail}` : p.stage } }).catch(() => undefined)
      },
    })

    // 10. armazenamento
    const outId = crypto.randomUUID()
    const outKey = objectKey.render(job.workspaceId, job.id, 'video.mp4')
    await ctx.storage.upload(outKey, result.outputPath, 'video/mp4')
    const size = (await stat(result.outputPath)).size
    await ctx.db.asset.create({
      data: { id: outId, workspaceId: job.workspaceId, kind: 'VIDEO', status: 'READY', source: 'RENDER', storageKey: outKey, mimeType: 'video/mp4', sizeBytes: BigInt(size), originalName: `exportacao-${job.id.slice(0, 8)}.mp4`, durationFlicks: BigInt(result.totalFlicks), width: result.outputWidth, height: result.outputHeight, fpsNum: doc.settings.fps.num, fpsDen: doc.settings.fps.den, hasVideo: true, hasAudio: true, sampleRate: 48000, channels: 2 },
    })
    let captionsAssetId: string | null = null
    if (result.srtPath && result.vttPath) {
      captionsAssetId = crypto.randomUUID()
      const srtKey = objectKey.render(job.workspaceId, job.id, 'legendas.srt')
      await ctx.storage.upload(srtKey, result.srtPath, 'application/x-subrip')
      await ctx.storage.upload(srtKey.replace(/\.srt$/, '.vtt'), result.vttPath, 'text/vtt')
      await ctx.db.asset.create({ data: { id: captionsAssetId, workspaceId: job.workspaceId, kind: 'SUBTITLE', status: 'READY', source: 'RENDER', storageKey: srtKey, mimeType: 'application/x-subrip', originalName: 'legendas.srt' } })
    }
    await ctx.db.renderJob.update({
      where: { id: job.id },
      data: { status: 'succeeded', progress: 1, stage: 'concluído', outputAssetId: outId, captionsAssetId, validation: { ...result.validation, reusedIntermediates: result.reusedIntermediates } as unknown as Prisma.InputJsonValue, finishedAt: new Date() },
    })
    ctx.log('render.succeeded', { renderJobId: job.id, seconds: result.validation.durationSeconds, reused: result.reusedIntermediates })
    await rm(workDir, { recursive: true, force: true })
  } catch (err) {
    const canceled = controller.signal.aborted || err instanceof RenderCanceled
    if (canceled) {
      await ctx.db.renderJob.update({ where: { id: job.id }, data: { status: 'canceled', finishedAt: new Date(), stage: 'cancelado' } })
      await rm(workDir, { recursive: true, force: true })
      return
    }
    const message = err instanceof FfmpegError ? `${err.message}\n${err.stderrTail.split('\n').slice(-6).join('\n')}` : (err as Error).message
    const final = attempt + 1 >= maxAttempts || /Projeto inválido|Validação do arquivo/.test(message)
    await ctx.db.renderJob.update({ where: { id: job.id }, data: { status: final ? 'failed' : 'queued', error: message.slice(0, 2000), ...(final ? { finishedAt: new Date() } : {}) } })
    ctx.log('render.error', { renderJobId: job.id, final, message: message.slice(0, 300) })
    if (final) {
      await rm(workDir, { recursive: true, force: true })
      return
    }
    throw err
  } finally {
    clearInterval(cancelPoll)
  }
}
