import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Asset } from '@orion/db'
import { ALLOWED_FORMATS, computePeaks, detectSilence, extractAudio, extractFrame, makeProxy, makeThumbnail, probeFile, reverseSegment, type MediaInfo } from '@orion/media'
import { type MediaJob, objectKey, userFacingError } from '@orion/server'
import type { WorkerContext } from '../context.ts'

/**
 * Ingestão e derivados. Arquivos enviados são entradas NÃO confiáveis:
 *  - ffprobe com protocol_whitelist=file e lista de formatos permitidos;
 *  - o tipo detectado precisa bater com o tipo declarado no upload;
 *  - todo processamento tem timeout e roda em diretório temporário do job.
 */

function asSec(f: number | null) {
  return f === null ? 0 : f / 705_600_000
}

async function updateFromProbe(ctx: WorkerContext, asset: Asset, info: MediaInfo, sizeBytes: number) {
  await ctx.db.asset.update({
    where: { id: asset.id },
    data: {
      kind: info.kind,
      durationFlicks: info.durationFlicks === null ? null : BigInt(info.durationFlicks),
      width: info.width,
      height: info.height,
      fpsNum: info.fps?.num ?? null,
      fpsDen: info.fps?.den ?? null,
      variableFrameRate: info.variableFrameRate,
      rotation: info.rotation,
      hasVideo: info.kind === 'VIDEO',
      hasAudio: info.hasAudio,
      sampleRate: info.sampleRate,
      channels: info.channels,
      sizeBytes: BigInt(sizeBytes),
      probe: { formatName: info.formatName, videoCodec: info.videoCodec, audioCodec: info.audioCodec, durationDivergenceMs: info.durationDivergenceMs, containerDurationFlicks: info.containerDurationFlicks },
    },
  })
}

/** Gera miniatura, forma de onda e proxy; envia ao armazenamento. */
async function derivatives(ctx: WorkerContext, asset: Asset, path: string, info: MediaInfo, dir: string) {
  const ws = asset.workspaceId
  const data: { thumbnailKey?: string; waveformKey?: string; proxyKey?: string } = {}
  if (info.kind === 'VIDEO' || info.kind === 'IMAGE') {
    const thumb = join(dir, 'thumb.jpg')
    await makeThumbnail(path, thumb, info, { timeoutMs: 120_000 })
    data.thumbnailKey = objectKey.derived(ws, asset.id, 'thumb.jpg')
    await ctx.storage.upload(data.thumbnailKey, thumb, 'image/jpeg')
  }
  if (info.hasAudio && info.durationFlicks) {
    const peaks = await computePeaks(path, asSec(info.durationFlicks), { timeoutMs: 15 * 60_000 })
    const wf = join(dir, 'waveform.json')
    await writeFile(wf, JSON.stringify(peaks))
    data.waveformKey = objectKey.derived(ws, asset.id, 'waveform.json')
    await ctx.storage.upload(data.waveformKey, wf, 'application/json')
  }
  if (info.kind === 'VIDEO' || info.kind === 'AUDIO') {
    const ext = info.kind === 'VIDEO' ? 'mp4' : 'm4a'
    const proxy = join(dir, `proxy.${ext}`)
    const webm = join(dir, 'proxy.webm')
    await makeProxy(path, proxy, info, { timeoutMs: Math.max(10 * 60_000, asSec(info.durationFlicks) * 4000) }, webm)
    data.proxyKey = objectKey.derived(ws, asset.id, `proxy.${ext}`)
    await ctx.storage.upload(data.proxyKey, proxy, info.kind === 'VIDEO' ? 'video/mp4' : 'audio/mp4')
    // variante aberta (VP9/Opus) na mesma pasta, por convenção: proxy.webm
    await ctx.storage.upload(objectKey.derived(ws, asset.id, 'proxy.webm'), webm, 'video/webm')
  }
  return data
}

async function fail(ctx: WorkerContext, assetId: string, message: string) {
  await ctx.db.asset.update({ where: { id: assetId }, data: { status: 'FAILED', error: message } })
  ctx.log('asset.failed', { assetId, message })
}

export async function runMediaJob(ctx: WorkerContext, job: MediaJob, attempt: number, maxAttempts: number) {
  const dir = join(ctx.tmpDir, 'media', `${job.type}-${job.assetId}`)
  await mkdir(dir, { recursive: true })
  try {
    if (job.type === 'silence') return await silence(ctx, job, dir)
    const asset = await ctx.db.asset.findUnique({ where: { id: job.assetId } })
    if (!asset || asset.deletedAt) return
    if (asset.status === 'READY') return // idempotente
    try {
      if (job.type === 'ingest') await ingest(ctx, asset, dir)
      else await derive(ctx, asset, job, dir)
    } catch (err) {
      const msg = userFacingError(err)
      if (attempt + 1 >= maxAttempts || /não permitido|não corresponde|inválid/.test(msg)) {
        await fail(ctx, asset.id, msg.slice(0, 500))
        return
      }
      throw err
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function ingest(ctx: WorkerContext, asset: Asset, dir: string) {
  const src = join(dir, `original${asset.storageKey.slice(asset.storageKey.lastIndexOf('.'))}`)
  await ctx.storage.download(asset.storageKey, src)
  const size = (await stat(src)).size
  if (asset.kind === 'SUBTITLE') {
    await ctx.db.asset.update({ where: { id: asset.id }, data: { status: 'READY', sizeBytes: BigInt(size) } })
    return
  }
  const info = await probeFile(src, 60_000, true)
  if (!ALLOWED_FORMATS.test(info.formatName)) throw new Error(`Formato "${info.formatName}" não permitido.`)
  if (info.kind !== asset.kind) throw new Error(`Conteúdo (${info.kind}) não corresponde ao tipo declarado (${asset.kind}).`)
  if (info.kind !== 'IMAGE' && !info.durationFlicks) throw new Error('Duração inválida ou arquivo corrompido.')
  if ((info.width ?? 0) > 8192 || (info.height ?? 0) > 8192) throw new Error('Resolução acima do limite operacional (8192 px).')
  await updateFromProbe(ctx, asset, info, size)
  const data = await derivatives(ctx, asset, src, info, dir)
  await ctx.db.asset.update({ where: { id: asset.id }, data: { ...data, status: 'READY', error: null } })
  ctx.log('asset.ready', { assetId: asset.id, kind: info.kind, vfr: info.variableFrameRate, rotation: info.rotation })
}

async function derive(ctx: WorkerContext, asset: Asset, job: Exclude<MediaJob, { type: 'ingest' | 'silence' }>, dir: string) {
  const source = await ctx.db.asset.findUniqueOrThrow({ where: { id: job.sourceAssetId } })
  const src = join(dir, `source${source.storageKey.slice(source.storageKey.lastIndexOf('.'))}`)
  await ctx.storage.download(source.storageKey, src)
  const out = join(dir, `out${asset.storageKey.slice(asset.storageKey.lastIndexOf('.'))}`)
  if (job.type === 'reverse') await reverseSegment(src, job.sourceIn, job.duration, join(dir, 'rev'), out, source.hasAudio, { timeoutMs: 30 * 60_000 })
  else if (job.type === 'freeze') await extractFrame(src, job.at, out)
  else await extractAudio(src, out, { timeoutMs: 30 * 60_000 })
  await ctx.storage.upload(asset.storageKey, out, asset.mimeType)
  const info = await probeFile(out)
  await updateFromProbe(ctx, asset, info, (await stat(out)).size)
  const data = await derivatives(ctx, asset, out, info, dir)
  await ctx.db.asset.update({ where: { id: asset.id }, data: { ...data, status: 'READY' } })
}

async function silence(ctx: WorkerContext, job: Extract<MediaJob, { type: 'silence' }>, dir: string) {
  const key = `silence:${job.requestId}`
  const meta = JSON.parse((await ctx.redis.get(key)) ?? '{}') as { workspaceId?: string; noiseDb?: number; minSeconds?: number }
  const asset = await ctx.db.asset.findUniqueOrThrow({ where: { id: job.assetId } })
  const src = join(dir, `src${asset.storageKey.slice(asset.storageKey.lastIndexOf('.'))}`)
  try {
    await ctx.storage.download(asset.storageKey, src)
    const intervals = await detectSilence(src, meta.noiseDb ?? -35, meta.minSeconds ?? 0.6, { timeoutMs: 20 * 60_000 })
    await ctx.redis.set(key, JSON.stringify({ ...meta, status: 'succeeded', assetId: asset.id, intervals }), 'EX', 3600)
  } catch (err) {
    await ctx.redis.set(key, JSON.stringify({ ...meta, status: 'failed', error: userFacingError(err).slice(0, 300) }), 'EX', 3600)
  }
}
