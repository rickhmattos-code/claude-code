import type { PrismaClient, Prisma } from '@orion/db'
import type { TimelineDoc } from '@orion/shared'
import { isMediaClip } from '@orion/timeline'

type Tx = Prisma.TransactionClient | PrismaClient

/** IDs de ativos referenciados por um documento (clipes de mídia). */
export function referencedAssetIds(doc: TimelineDoc): string[] {
  const ids = new Set<string>()
  for (const t of doc.tracks) for (const c of t.clips) if (isMediaClip(c)) ids.add(c.assetId)
  return [...ids]
}

/**
 * Garante que todos os ativos citados pertencem ao workspace do projeto
 * (impede referenciar mídia de terceiros adivinhando IDs).
 */
export async function assertAssetsInWorkspace(db: Tx, workspaceId: string, doc: TimelineDoc): Promise<string[]> {
  const ids = referencedAssetIds(doc)
  if (!ids.length) return []
  const found = await db.asset.findMany({ where: { id: { in: ids }, OR: [{ workspaceId }, { source: 'CATALOG' }], deletedAt: null }, select: { id: true } })
  const ok = new Set(found.map((a) => a.id))
  return ids.filter((id) => !ok.has(id))
}

/**
 * Projeção relacional da timeline (fonte de verdade = Project.document).
 * Mantida para integridade referencial (Clip → Asset com RESTRICT), coleta
 * de lixo de ativos e consultas. Recriada a cada salvamento na mesma
 * transação.
 */
export async function syncTimelineProjection(db: Tx, projectId: string, doc: TimelineDoc, docVersion: number, durationFlicks: number) {
  const timeline = await db.timeline.upsert({
    where: { projectId },
    create: { projectId, durationFlicks: BigInt(durationFlicks), fpsNum: doc.settings.fps.num, fpsDen: doc.settings.fps.den, width: doc.settings.width, height: doc.settings.height, docVersion },
    update: { durationFlicks: BigInt(durationFlicks), fpsNum: doc.settings.fps.num, fpsDen: doc.settings.fps.den, width: doc.settings.width, height: doc.settings.height, docVersion },
  })
  await db.track.deleteMany({ where: { timelineId: timeline.id } })
  await db.captionSegment.deleteMany({ where: { timelineId: timeline.id } })
  if (doc.tracks.length) {
    await db.track.createMany({
      data: doc.tracks.map((t, index) => ({ id: `${timeline.id.slice(0, 8)}_${t.id}`.slice(0, 64), timelineId: timeline.id, kind: t.kind, name: t.name, index, muted: t.muted, locked: t.locked, hidden: t.hidden, solo: t.solo })),
    })
  }
  const clips: Prisma.ClipCreateManyInput[] = []
  const effects: Prisma.EffectCreateManyInput[] = []
  const keyframes: Prisma.KeyframeCreateManyInput[] = []
  const pid = timeline.id.slice(0, 8)
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      const clipId = `${pid}_${c.id}`.slice(0, 64)
      const { keyframes: kfs, effects: efs, ...rest } = c
      clips.push({
        id: clipId,
        trackId: `${pid}_${t.id}`.slice(0, 64),
        assetId: isMediaClip(c) ? c.assetId : null,
        kind: c.type,
        startFlicks: BigInt(c.start),
        durationFlicks: BigInt(c.duration),
        sourceInFlicks: BigInt(isMediaClip(c) ? c.sourceIn : 0),
        speed: isMediaClip(c) ? c.speed : 1,
        props: rest as unknown as Prisma.InputJsonValue,
      })
      efs.forEach((e, order) => effects.push({ id: `${pid}_${e.id}_${clipId}`.slice(0, 120), clipId, type: e.type, order, params: e as unknown as Prisma.InputJsonValue }))
      for (const k of kfs) keyframes.push({ clipId, property: k.property, timeFlicks: BigInt(k.time), value: k.value, easing: k.easing })
    }
  }
  if (clips.length) await db.clip.createMany({ data: clips })
  if (effects.length) await db.effect.createMany({ data: effects })
  if (keyframes.length) await db.keyframe.createMany({ data: keyframes })
  if (doc.captions.segments.length) {
    await db.captionSegment.createMany({
      data: doc.captions.segments.map((s) => ({
        id: `${pid}_${s.id}`.slice(0, 64),
        timelineId: timeline.id,
        startFlicks: BigInt(s.start),
        endFlicks: BigInt(s.end),
        text: s.text,
        speaker: s.speaker ?? null,
        words: (s.words ?? null) as unknown as Prisma.InputJsonValue,
        linkedClipId: s.linkedClipId ?? null,
      })),
    })
  }
}

export async function audit(
  db: Tx,
  e: { workspaceId?: string | null; userId?: string | null; action: string; targetType: string; targetId?: string | null; meta?: Record<string, unknown>; ip?: string | null },
) {
  await db.auditEvent.create({
    data: {
      workspaceId: e.workspaceId ?? null,
      userId: e.userId ?? null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId ?? null,
      meta: (e.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: e.ip ?? null,
    },
  })
}

/** Gasto do mês corrente (estimado pendente + confirmado), em centavos. */
export async function monthlySpend(db: Tx, workspaceId: string): Promise<{ estimatedPending: number; confirmed: number }> {
  const start = new Date()
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  const rows = await db.usageLedger.findMany({ where: { workspaceId, createdAt: { gte: start }, status: { in: ['ESTIMATED', 'CONFIRMED'] } }, select: { status: true, estimatedCents: true, confirmedCents: true } })
  let estimatedPending = 0
  let confirmed = 0
  for (const r of rows) {
    if (r.status === 'CONFIRMED') confirmed += r.confirmedCents ?? r.estimatedCents
    else estimatedPending += r.estimatedCents
  }
  return { estimatedPending, confirmed }
}

export const objectKey = {
  upload: (ws: string, assetId: string, ext: string) => `ws/${ws}/assets/${assetId}/original${ext}`,
  derived: (ws: string, assetId: string, name: string) => `ws/${ws}/assets/${assetId}/${name}`,
  render: (ws: string, renderId: string, name: string) => `ws/${ws}/renders/${renderId}/${name}`,
  catalog: (file: string) => `catalog/${file}`,
}

export function extFor(mime: string, fileName: string): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(fileName)?.[1]?.toLowerCase()
  const map: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-matroska': '.mkv',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/wave': '.wav',
    'audio/aac': '.aac',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'audio/flac': '.flac',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'application/x-subrip': '.srt',
    'text/vtt': '.vtt',
  }
  return map[mime] ?? (fromName ? `.${fromName}` : '.bin')
}

export function kindForMime(mime: string): 'VIDEO' | 'AUDIO' | 'IMAGE' | 'SUBTITLE' {
  if (mime.startsWith('video/')) return 'VIDEO'
  if (mime.startsWith('audio/')) return 'AUDIO'
  if (mime.startsWith('image/')) return 'IMAGE'
  return 'SUBTITLE'
}
