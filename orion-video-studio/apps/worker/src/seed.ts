/**
 * Seed idempotente:
 *  - workspace de sistema "Catálogo Orion" com a biblioteca musical/efeitos
 *    demonstrativos (licença CC0 registrada em LicenseRecord);
 *  - 10 templates de sistema (versão do arquivo templates-data.ts);
 *  - com SEED_DEMO=1: usuário demo@orion.local (senha orion-demo-2026),
 *    mídias de exemplo e um projeto de exemplo de ~90 s.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Prisma } from '@orion/db'
import { probeFile } from '@orion/media'
import { createQueues, createStorage, objectKey, redisConnection, syncTimelineProjection } from '@orion/server'
import { SYSTEM_TEMPLATES, type TimelineDoc } from '@orion/shared'
import { addCaption, addClip, applyZoom, createDocument, docDuration, makeMediaClip, makeTextClip, secondsToFlicks, updateClip } from '@orion/timeline'
import { getPrisma } from '@orion/db'
import { hashPasswordForSeed } from './seed-hash.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const db = getPrisma()
const storage = createStorage(process.env)
const redis = redisConnection()
const queues = createQueues(redis)

const CATALOG_WS = '00000000-0000-4000-8000-000000000001'

async function main() {
  await db.workspace.upsert({ where: { id: CATALOG_WS }, create: { id: CATALOG_WS, name: 'Catálogo Orion (sistema)', plan: 'system', quotaBytes: 0n, generationBudgetCents: 0 }, update: {} })

  // templates
  for (const t of SYSTEM_TEMPLATES) {
    const found = await db.template.findFirst({ where: { workspaceId: null, slug: t.slug, version: t.version } })
    if (!found) await db.template.create({ data: { slug: t.slug, version: t.version, name: t.name, category: t.category, isSystem: true, definition: t as unknown as Prisma.InputJsonValue } })
  }

  // biblioteca musical
  const catalog = JSON.parse(readFileSync(join(root, 'assets/catalog.json'), 'utf8')) as {
    license: { source: string; author: string; licenseName: string; licenseUrl: string; commercialUse: boolean; attributionRequired: boolean; platformRestrictions: string | null }
    tracks: Array<{ file: string; title: string; artist: string; genre: string; mood: string; bpm: number | null; isSfx: boolean }>
  }
  let license = await db.licenseRecord.findFirst({ where: { source: catalog.license.source } })
  license ??= await db.licenseRecord.create({ data: { ...catalog.license, attributionText: null } })
  for (const t of catalog.tracks) {
    const key = objectKey.catalog(t.file)
    const exists = await db.asset.findUnique({ where: { storageKey: key } })
    if (exists) continue
    const path = join(root, 'assets', t.file)
    const info = await probeFile(path)
    await storage.upload(key, path, 'audio/mp4')
    const asset = await db.asset.create({
      data: { workspaceId: CATALOG_WS, kind: 'AUDIO', status: 'PROCESSING', source: 'CATALOG', storageKey: key, mimeType: 'audio/mp4', sizeBytes: BigInt(readFileSync(path).length), originalName: t.title, durationFlicks: BigInt(info.durationFlicks ?? 0), hasAudio: true, sampleRate: info.sampleRate, channels: info.channels },
    })
    await db.musicTrack.create({ data: { workspaceId: null, assetId: asset.id, licenseRecordId: license.id, title: t.title, artist: t.artist, genre: t.genre, mood: t.mood, bpm: t.bpm, isSfx: t.isSfx, durationFlicks: BigInt(info.durationFlicks ?? 0) } })
    await queues.media.add('ingest', { type: 'ingest', assetId: asset.id }, { jobId: `ingest-${asset.id}` })
  }
  console.log(`catálogo: ${catalog.tracks.length} faixas, ${SYSTEM_TEMPLATES.length} modelos`)

  if (process.env.SEED_DEMO === '1') await demo()
}

async function importFixture(ws: string, file: string, mime: string, kind: 'VIDEO' | 'AUDIO' | 'IMAGE') {
  const path = join(root, 'tests/fixtures/media', file)
  const info = await probeFile(path)
  const id = crypto.randomUUID()
  const key = objectKey.upload(ws, id, file.slice(file.lastIndexOf('.')))
  await storage.upload(key, path, mime)
  await db.asset.create({
    data: { id, workspaceId: ws, kind, status: 'PROCESSING', source: 'UPLOAD', storageKey: key, mimeType: mime, sizeBytes: BigInt(readFileSync(path).length), originalName: file },
  })
  await queues.media.add('ingest', { type: 'ingest', assetId: id }, { jobId: `ingest-${id}` })
  return { id, durationFlicks: info.durationFlicks }
}

async function demo() {
  const email = 'demo@orion.local'
  let user = await db.user.findUnique({ where: { email } })
  if (user) {
    console.log('demo já existe')
    return
  }
  user = await db.user.create({ data: { email, name: 'Luís Henrique de Matos', passwordHash: await hashPasswordForSeed('orion-demo-2026') } })
  const ws = await db.workspace.create({ data: { name: 'Estúdio Demo', quotaBytes: 20n * 1024n ** 3n, generationBudgetCents: 2000 } })
  await db.membership.create({ data: { userId: user.id, workspaceId: ws.id, role: 'OWNER' } })
  await db.brandKit.create({
    data: { workspaceId: ws.id, name: 'O Vendedor de Aço', displayName: 'Luís Henrique de Matos', socialHandle: '@ovendedordeaco08', signature: 'Disciplina que vende.', palette: { primary: '#F2A93B', secondary: '#6E8BFF', background: '#0F1220', text: '#FFFFFF' }, fonts: { heading: 'Inter Display', body: 'Inter' }, captionStyle: { highlightColor: '#F2A93B' } },
  })
  const v = await importFixture(ws.id, 'video_30fps_1080p_20s.mp4', 'video/mp4', 'VIDEO')
  const img = await importFixture(ws.id, 'image_portrait.png', 'image/png', 'IMAGE')
  const nar = await importFixture(ws.id, 'tone_narration_30s.wav', 'audio/wav', 'AUDIO')
  const music = await db.musicTrack.findFirst({ where: { title: 'Aurora Calma' } })

  let doc: TimelineDoc = createDocument({ aspect: '9:16' })
  const [main, , text, voice, musicTrack] = doc.tracks
  const S = secondsToFlicks
  doc = addClip(doc, main!.id, makeMediaClip('video', v.id, 0, S(20), 'Abertura'))
  const still = makeMediaClip('image', img.id, S(20), S(70), 'Desenvolvimento')
  still.transitionIn = { type: 'dissolve', duration: S(0.5) }
  doc = addClip(doc, main!.id, still)
  doc = applyZoom(doc, still.id, 'in', 0.1)
  const t = makeTextClip('Disciplina vence talento\nquando o talento não treina', S(1), S(5))
  doc = addClip(doc, text!.id, t)
  doc = updateClip(doc, t.id, (c) => {
    if (c.type === 'text') c.animation = 'pop'
  })
  doc = addClip(doc, voice!.id, makeMediaClip('audio', nar.id, S(2), S(30), 'Narração (tom de teste)'))
  if (music) {
    const m = makeMediaClip('audio', music.assetId, 0, Math.min(Number(music.durationFlicks), S(82)), 'Aurora Calma')
    doc = addClip(doc, musicTrack!.id, m)
  }
  doc = addCaption(doc, { start: S(2), end: S(5), text: 'Este é um projeto de exemplo' })
  doc = addCaption(doc, { start: S(5.2), end: S(8), text: 'Edite, salve e exporte acima de 60 segundos' })
  const project = await db.project.create({ data: { workspaceId: ws.id, name: 'Exemplo — 90 segundos', document: doc as unknown as Prisma.InputJsonValue, createdById: user.id } })
  await syncTimelineProjection(db, project.id, doc, 1, docDuration(doc))
  await db.projectRevision.create({ data: { projectId: project.id, number: 1, document: doc as unknown as Prisma.InputJsonValue, docVersion: 1, reason: 'Seed', createdById: user.id } })
  console.log(`demo: ${email} / orion-demo-2026 — projeto ${project.id}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await queues.close()
    redis.disconnect()
    await db.$disconnect()
  })
