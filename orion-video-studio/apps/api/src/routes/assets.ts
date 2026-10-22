import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { toNum } from '@orion/db'
import { LocalStorage, audit, extFor, kindForMime, objectKey } from '@orion/server'
import { CompleteUploadBody, CreateUploadBody, DeriveAssetBody } from '@orion/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type Deps, HttpError, notFound, requireMember, route } from '../core.ts'
import { assetDto } from '../dto.ts'

const SINGLE_MAX = 32 * 1024 * 1024
const PART_SIZE = 16 * 1024 * 1024
const UPLOAD_TTL_SEC = 6 * 3600

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  json: 'application/json',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
}

export async function loadAsset(deps: Deps, userId: string, id: string, min: 'VIEWER' | 'EDITOR' = 'VIEWER') {
  const a = await deps.db.asset.findFirst({ where: { id, deletedAt: null } })
  if (!a) throw notFound('Mídia')
  if (a.source === 'CATALOG') return a
  await requireMember(deps, userId, a.workspaceId, min).catch(() => {
    throw notFound('Mídia')
  })
  return a
}

export function registerAssets(app: FastifyInstance, deps: Deps) {
  // corpo binário como stream (upload direto via URL assinada do driver local)
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload))

  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/uploads', summary: 'Iniciar upload (URL assinada; multipart acima de 32 MB)', tag: 'assets', body: CreateUploadBody, rateLimit: { max: 120, timeWindow: '1 minute' } }, async ({ user, params, body }) => {
    const ws = params.ws!
    await requireMember(deps, user.id, ws, 'EDITOR')
    if (body.sizeBytes > deps.config.MAX_UPLOAD_BYTES) {
      throw new HttpError(413, 'too_large', `Arquivo acima do limite de ${Math.round(deps.config.MAX_UPLOAD_BYTES / 1024 ** 3)} GB.`)
    }
    const workspace = await deps.db.workspace.findUniqueOrThrow({ where: { id: ws } })
    const used = await deps.db.asset.aggregate({ where: { workspaceId: ws, deletedAt: null }, _sum: { sizeBytes: true } })
    if ((toNum(used._sum.sizeBytes) ?? 0) + body.sizeBytes > Number(workspace.quotaBytes)) {
      throw new HttpError(413, 'quota_exceeded', 'Cota de armazenamento do workspace atingida. Exclua mídias não usadas ou amplie o plano.')
    }
    const assetId = crypto.randomUUID()
    const key = objectKey.upload(ws, assetId, extFor(body.mimeType, body.fileName))
    const mode = body.sizeBytes > SINGLE_MAX ? 'MULTIPART' : 'SINGLE'
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SEC * 1000)
    let s3UploadId: string | null = null
    let url: string | null = null
    let parts: Array<{ partNumber: number; url: string }> = []
    if (mode === 'SINGLE') {
      url = await deps.storage.presignPut(key, body.mimeType, body.sizeBytes, UPLOAD_TTL_SEC)
    } else {
      s3UploadId = await deps.storage.createMultipart(key, body.mimeType)
      const count = Math.ceil(body.sizeBytes / PART_SIZE)
      if (count > 10000) throw new HttpError(413, 'too_many_parts', 'Arquivo grande demais para multipart.')
      parts = await Promise.all(Array.from({ length: count }, async (_, i) => ({ partNumber: i + 1, url: await deps.storage.presignPart(key, s3UploadId!, i + 1, UPLOAD_TTL_SEC) })))
    }
    const upload = await deps.db.$transaction(async (tx) => {
      await tx.asset.create({
        data: { id: assetId, workspaceId: ws, kind: kindForMime(body.mimeType), status: 'PENDING', source: body.source, storageKey: key, mimeType: body.mimeType, sizeBytes: BigInt(body.sizeBytes), originalName: body.fileName.slice(0, 255) },
      })
      return tx.upload.create({ data: { workspaceId: ws, assetId, mode, storageKey: key, s3UploadId, expectedSize: BigInt(body.sizeBytes), partSize: mode === 'MULTIPART' ? PART_SIZE : null, expiresAt } })
    })
    return { uploadId: upload.id, assetId, mode, url, parts, partSize: mode === 'MULTIPART' ? PART_SIZE : null, expiresAt: expiresAt.toISOString() }
  })

  route(app, deps, { method: 'POST', url: '/api/uploads/:id/complete', summary: 'Concluir upload e iniciar inspeção', tag: 'assets', body: CompleteUploadBody }, async ({ user, params, body, req }) => {
    const up = await deps.db.upload.findUnique({ where: { id: params.id! } })
    if (!up) throw notFound('Upload')
    await requireMember(deps, user.id, up.workspaceId, 'EDITOR').catch(() => {
      throw notFound('Upload')
    })
    if (up.status === 'COMPLETED') return { assetId: up.assetId, status: 'PROCESSING' }
    if (up.status !== 'CREATED' || up.expiresAt < new Date()) throw new HttpError(410, 'upload_expired', 'Upload expirado ou cancelado. Envie novamente.')
    if (up.mode === 'MULTIPART') {
      if (!body.parts?.length) throw new HttpError(400, 'parts_required', 'Informe as partes enviadas.')
      await deps.storage.completeMultipart(up.storageKey, up.s3UploadId!, body.parts)
    }
    const head = await deps.storage.head(up.storageKey)
    if (!head) throw new HttpError(400, 'not_uploaded', 'Arquivo não encontrado no armazenamento. Envie o conteúdo antes de concluir.')
    if (head.size !== Number(up.expectedSize)) {
      await deps.storage.remove(up.storageKey)
      throw new HttpError(400, 'size_mismatch', `Tamanho recebido (${head.size}) difere do declarado (${up.expectedSize}).`)
    }
    await deps.db.$transaction([
      deps.db.upload.update({ where: { id: up.id }, data: { status: 'COMPLETED' } }),
      deps.db.asset.update({ where: { id: up.assetId }, data: { status: 'PROCESSING' } }),
    ])
    await deps.queues.media.add('ingest', { type: 'ingest', assetId: up.assetId }, { jobId: `ingest-${up.assetId}` })
    await audit(deps.db, { workspaceId: up.workspaceId, userId: user.id, action: 'asset.upload', targetType: 'asset', targetId: up.assetId, ip: req.ip })
    return { assetId: up.assetId, status: 'PROCESSING' }
  })

  route(app, deps, { method: 'POST', url: '/api/uploads/:id/abort', summary: 'Cancelar upload', tag: 'assets' }, async ({ user, params }) => {
    const up = await deps.db.upload.findUnique({ where: { id: params.id! } })
    if (!up) throw notFound('Upload')
    await requireMember(deps, user.id, up.workspaceId, 'EDITOR').catch(() => {
      throw notFound('Upload')
    })
    if (up.mode === 'MULTIPART' && up.s3UploadId && up.status === 'CREATED') await deps.storage.abortMultipart(up.storageKey, up.s3UploadId).catch(() => undefined)
    await deps.db.$transaction([
      deps.db.upload.update({ where: { id: up.id }, data: { status: 'ABORTED' } }),
      deps.db.asset.update({ where: { id: up.assetId }, data: { status: 'FAILED', error: 'Upload cancelado', deletedAt: new Date() } }),
    ])
    return { ok: true }
  })

  // ----- rotas do driver local (URLs assinadas; sem cookie) -----
  if (deps.storage instanceof LocalStorage) {
    const local = deps.storage
    app.put('/api/storage/:token', async (req, reply) => {
      const t = local.verify((req.params as { token: string }).token)
      if (!t || (t.op !== 'put' && t.op !== 'part')) throw new HttpError(403, 'invalid_signature', 'URL de upload inválida ou expirada.')
      const body = req.body as Readable
      if (!body || typeof (body as Readable).pipe !== 'function') throw new HttpError(400, 'no_body', 'Corpo ausente.')
      if (t.op === 'put') {
        const ct = String(req.headers['content-type'] ?? '').split(';')[0]
        if (t.ct && ct !== t.ct) throw new HttpError(400, 'content_type', 'Content-Type diferente do declarado.')
        await local.writeStream(t.key, body, t.max ?? 0)
        return reply.code(200).send({ ok: true })
      }
      const { etag } = await local.writePart(t.key, t.uploadId!, t.part!, body, PART_SIZE + 1024)
      return reply.header('etag', etag).header('access-control-expose-headers', 'ETag').code(200).send({ ok: true, etag })
    })
    app.get('/api/storage/:token', async (req, reply) => {
      const t = local.verify((req.params as { token: string }).token)
      if (!t || t.op !== 'get') throw new HttpError(403, 'invalid_signature', 'URL inválida ou expirada.')
      const path = local.pathFor(t.key)
      let size: number
      try {
        size = (await stat(path)).size
      } catch {
        throw notFound('Arquivo')
      }
      const ext = /\.([a-z0-9]+)$/i.exec(t.key)?.[1]?.toLowerCase() ?? ''
      reply.header('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream')
      reply.header('accept-ranges', 'bytes')
      reply.header('cache-control', 'private, max-age=3600')
      reply.header('x-content-type-options', 'nosniff')
      if (t.name) reply.header('content-disposition', `attachment; filename="${t.name.replace(/[^\w.-]/g, '_')}"`)
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
        let end = range[1] && range[2] ? Number(range[2]) : size - 1
        end = Math.min(end, size - 1)
        if (start > end || start >= size) {
          return reply.code(416).header('content-range', `bytes */${size}`).send()
        }
        start = Math.max(0, start)
        reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1)
        return reply.send(createReadStream(path, { start, end }))
      }
      reply.header('content-length', size)
      return reply.send(createReadStream(path))
    })
  }

  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/assets', summary: 'Biblioteca de mídia', tag: 'assets', query: z.object({ kind: z.enum(['VIDEO', 'AUDIO', 'IMAGE', 'SUBTITLE']).optional() }) }, async ({ user, params, query }) => {
    await requireMember(deps, user.id, params.ws!)
    const rows = await deps.db.asset.findMany({
      where: { workspaceId: params.ws!, deletedAt: null, source: { not: 'RENDER' }, ...(query.kind ? { kind: query.kind } : {}), status: { not: 'PENDING' } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    return Promise.all(rows.map((a) => assetDto(deps, a)))
  })

  route(app, deps, { method: 'GET', url: '/api/assets/:id', summary: 'Detalhes da mídia (URLs temporárias)', tag: 'assets' }, async ({ user, params }) => {
    return assetDto(deps, await loadAsset(deps, user.id, params.id!))
  })

  route(app, deps, { method: 'POST', url: '/api/assets/batch', summary: 'Detalhes de várias mídias', tag: 'assets', body: z.object({ ids: z.array(z.string().uuid()).max(500) }) }, async ({ user, body }) => {
    const rows = await deps.db.asset.findMany({ where: { id: { in: body.ids }, deletedAt: null } })
    const allowed: typeof rows = []
    const memberCache = new Map<string, boolean>()
    for (const a of rows) {
      if (a.source === 'CATALOG') {
        allowed.push(a)
        continue
      }
      if (!memberCache.has(a.workspaceId)) {
        memberCache.set(a.workspaceId, !!(await deps.db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: a.workspaceId } } })))
      }
      if (memberCache.get(a.workspaceId)) allowed.push(a)
    }
    return Promise.all(allowed.map((a) => assetDto(deps, a)))
  })

  route(app, deps, { method: 'DELETE', url: '/api/assets/:id', summary: 'Excluir mídia (somente sem referências)', tag: 'assets' }, async ({ user, params, req }) => {
    const a = await loadAsset(deps, user.id, params.id!, 'EDITOR')
    if (a.source === 'CATALOG') throw new HttpError(403, 'forbidden', 'Itens do catálogo não podem ser excluídos.')
    const clipRefs = await deps.db.clip.findMany({ where: { assetId: a.id }, select: { track: { select: { timeline: { select: { project: { select: { id: true, name: true } } } } } } }, take: 20 })
    const charRefs = await deps.db.characterReference.count({ where: { assetId: a.id } })
    const musicRefs = await deps.db.musicTrack.count({ where: { assetId: a.id } })
    if (clipRefs.length || charRefs || musicRefs) {
      const projects = [...new Map(clipRefs.map((c) => [c.track.timeline.project.id, c.track.timeline.project.name])).values()]
      throw new HttpError(409, 'asset_in_use', `Mídia em uso${projects.length ? ` nos projetos: ${projects.join(', ')}` : ''}${charRefs ? ' (referência de personagem)' : ''}${musicRefs ? ' (biblioteca musical)' : ''}. Remova as referências antes de excluir.`)
    }
    await deps.db.asset.update({ where: { id: a.id }, data: { deletedAt: new Date() } })
    await audit(deps.db, { workspaceId: a.workspaceId, userId: user.id, action: 'asset.delete', targetType: 'asset', targetId: a.id, ip: req.ip })
    return { ok: true }
  })

  route(app, deps, { method: 'POST', url: '/api/assets/:id/derive', summary: 'Derivar mídia (inverter, congelar quadro, extrair áudio)', tag: 'assets', body: DeriveAssetBody }, async ({ user, params, body }) => {
    const src = await loadAsset(deps, user.id, params.id!, 'EDITOR')
    if (src.status !== 'READY') throw new HttpError(409, 'not_ready', 'A mídia ainda está em processamento.')
    if (src.kind !== 'VIDEO' && body.op !== 'extract-audio') throw new HttpError(400, 'invalid', 'Operação disponível apenas para vídeo.')
    if (body.op === 'reverse' && body.duration > 300 * 705_600_000) throw new HttpError(400, 'too_long', 'Inversão limitada a 5 minutos por trecho.')
    const id = crypto.randomUUID()
    const meta = {
      reverse: { kind: 'VIDEO' as const, ext: '.mp4', mime: 'video/mp4', name: `${src.originalName} (invertido)` },
      freeze: { kind: 'IMAGE' as const, ext: '.png', mime: 'image/png', name: `${src.originalName} (quadro)` },
      'extract-audio': { kind: 'AUDIO' as const, ext: '.m4a', mime: 'audio/mp4', name: `${src.originalName} (áudio)` },
    }[body.op]
    await deps.db.asset.create({ data: { id, workspaceId: src.workspaceId, kind: meta.kind, status: 'PROCESSING', source: 'DERIVED', storageKey: objectKey.upload(src.workspaceId, id, meta.ext), mimeType: meta.mime, originalName: meta.name } })
    const job =
      body.op === 'reverse'
        ? { type: 'reverse' as const, assetId: id, sourceAssetId: src.id, sourceIn: body.sourceIn, duration: body.duration }
        : body.op === 'freeze'
          ? { type: 'freeze' as const, assetId: id, sourceAssetId: src.id, at: body.at }
          : { type: 'extract-audio' as const, assetId: id, sourceAssetId: src.id }
    await deps.queues.media.add(job.type, job, { jobId: `${job.type}-${id}` })
    return { assetId: id, status: 'PROCESSING' }
  })

  route(app, deps, { method: 'POST', url: '/api/assets/:id/silence', summary: 'Detectar silêncios (sugestão de cortes)', tag: 'assets', body: z.object({ noiseDb: z.number().min(-80).max(-10).default(-35), minSeconds: z.number().min(0.2).max(10).default(0.6) }) }, async ({ user, params, body }) => {
    const a = await loadAsset(deps, user.id, params.id!)
    if (!a.hasAudio) throw new HttpError(400, 'no_audio', 'Mídia sem áudio.')
    const requestId = crypto.randomUUID()
    await deps.redis.set(`silence:${requestId}`, JSON.stringify({ status: 'queued', workspaceId: a.workspaceId, ...body }), 'EX', 3600)
    await deps.queues.media.add('silence', { type: 'silence', assetId: a.id, requestId }, { jobId: `silence-${requestId}` })
    return { requestId }
  })

  route(app, deps, { method: 'GET', url: '/api/silence/:requestId', summary: 'Resultado da detecção de silêncio', tag: 'assets' }, async ({ user, params }) => {
    const raw = await deps.redis.get(`silence:${params.requestId}`)
    if (!raw) throw notFound('Análise')
    const data = JSON.parse(raw) as { workspaceId: string }
    await requireMember(deps, user.id, data.workspaceId).catch(() => {
      throw notFound('Análise')
    })
    return data
  })
}
