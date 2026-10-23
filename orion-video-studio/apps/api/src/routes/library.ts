import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Prisma } from '@orion/db'
import { toNum } from '@orion/db'
import {
  IMAGE_ADAPTERS,
  TRANSCRIPTION_ADAPTERS,
  TTS_ADAPTERS,
  VIDEO_ADAPTERS,
  findTts,
  llmCommand,
  llmPlan,
  localPlan,
  providerStatuses,
  scriptAdapter,
  translationAdapter,
} from '@orion/providers'
import { audit, monthlySpend } from '@orion/server'
import {
  AssistantBrief,
  AssistantCommandBody,
  BrandKitBody,
  CharacterBody,
  MusicQuery,
  RegisterUserMusicBody,
  SaveTemplateBody,
  TemplateDefinition,
  VoiceProfileBody,
} from '@orion/shared'
import { parseCommand } from '@orion/timeline'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type Deps, HttpError, notFound, requireMember, route } from '../core.ts'
import { assetDto } from '../dto.ts'

async function ownedBy<T extends { workspaceId: string | null }>(deps: Deps, userId: string, row: T | null, what: string, min: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<T> {
  if (!row || !row.workspaceId) throw notFound(what)
  await requireMember(deps, userId, row.workspaceId, min).catch(() => {
    throw notFound(what)
  })
  return row
}

async function assertWorkspaceAssets(deps: Deps, ws: string, ids: Array<string | null | undefined>, kind?: 'IMAGE' | 'VIDEO' | 'AUDIO') {
  const list = ids.filter((x): x is string => !!x)
  if (!list.length) return
  const n = await deps.db.asset.count({ where: { id: { in: list }, workspaceId: ws, deletedAt: null, ...(kind ? { kind } : {}) } })
  if (n !== new Set(list).size) throw new HttpError(400, 'asset_invalid', 'Mídia não encontrada neste espaço de trabalho (ou de tipo incorreto).')
}

export function registerLibrary(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------ templates
  route(app, deps, { method: 'GET', url: '/api/templates', summary: 'Modelos do sistema e do espaço de trabalho (última versão)', tag: 'templates', query: z.object({ workspaceId: z.string().uuid().optional() }) }, async ({ user, query }) => {
    if (query.workspaceId) await requireMember(deps, user.id, query.workspaceId)
    const rows = await deps.db.template.findMany({ where: { OR: [{ workspaceId: null }, ...(query.workspaceId ? [{ workspaceId: query.workspaceId }] : [])] }, orderBy: [{ slug: 'asc' }, { version: 'desc' }] })
    const latest = new Map<string, (typeof rows)[number]>()
    for (const r of rows) {
      const k = `${r.workspaceId ?? 'sys'}:${r.slug}`
      if (!latest.has(k)) latest.set(k, r)
    }
    return [...latest.values()].map((t) => ({ id: t.id, slug: t.slug, version: t.version, name: t.name, category: t.category, isSystem: t.isSystem, workspaceId: t.workspaceId, definition: t.definition }))
  })

  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/templates', summary: 'Salvar modelo próprio (nova versão se o slug existir)', tag: 'templates', body: SaveTemplateBody }, async ({ user, params, body }) => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    const def = TemplateDefinition.parse(body.definition)
    const last = await deps.db.template.findFirst({ where: { workspaceId: params.ws!, slug: def.slug }, orderBy: { version: 'desc' } })
    const version = (last?.version ?? 0) + 1
    const t = await deps.db.template.create({ data: { workspaceId: params.ws!, slug: def.slug, version, name: def.name, category: def.category, definition: { ...def, version } as unknown as Prisma.InputJsonValue } })
    return { id: t.id, version }
  })

  route(app, deps, { method: 'POST', url: '/api/templates/:id/duplicate', summary: 'Duplicar modelo para o espaço de trabalho', tag: 'templates', body: z.object({ workspaceId: z.string().uuid(), slug: z.string().regex(/^[a-z0-9-]{2,60}$/), name: z.string().min(1).max(80) }) }, async ({ user, params, body }) => {
    await requireMember(deps, user.id, body.workspaceId, 'EDITOR')
    const src = await deps.db.template.findUnique({ where: { id: params.id! } })
    if (!src || (src.workspaceId && src.workspaceId !== body.workspaceId)) throw notFound('Modelo')
    const def = TemplateDefinition.parse({ ...(src.definition as object), slug: body.slug, name: body.name, version: 1, category: (src.definition as { category: string }).category })
    const exists = await deps.db.template.findFirst({ where: { workspaceId: body.workspaceId, slug: body.slug } })
    if (exists) throw new HttpError(409, 'slug_taken', 'Já existe um modelo com este identificador.')
    const t = await deps.db.template.create({ data: { workspaceId: body.workspaceId, slug: def.slug, version: 1, name: def.name, category: def.category, definition: def as unknown as Prisma.InputJsonValue } })
    return { id: t.id }
  })

  route(app, deps, { method: 'DELETE', url: '/api/templates/:id', summary: 'Excluir modelo próprio (todas as versões)', tag: 'templates' }, async ({ user, params }) => {
    const t = await ownedBy(deps, user.id, await deps.db.template.findUnique({ where: { id: params.id! } }), 'Template', 'EDITOR')
    await deps.db.template.deleteMany({ where: { workspaceId: t.workspaceId, slug: t.slug } })
    return { ok: true }
  })

  // ------------------------------------------------------------ brand kits
  const brandOut = (b: Prisma.BrandKitGetPayload<object>) => ({
    id: b.id,
    workspaceId: b.workspaceId,
    name: b.name,
    displayName: b.displayName,
    socialHandle: b.socialHandle,
    signature: b.signature,
    palette: b.palette,
    fonts: b.fonts,
    captionStyleOverrides: b.captionStyle,
    logoAssetId: b.logoAssetId,
    watermarkAssetId: b.watermarkAssetId,
    introAssetId: b.introAssetId,
    outroAssetId: b.outroAssetId,
  })
  const brandData = (body: z.infer<typeof BrandKitBody>) => ({
    name: body.name,
    displayName: body.displayName,
    socialHandle: body.socialHandle ?? null,
    signature: body.signature ?? null,
    palette: body.palette,
    fonts: body.fonts,
    captionStyle: body.captionStyleOverrides,
    logoAssetId: body.logoAssetId ?? null,
    watermarkAssetId: body.watermarkAssetId ?? null,
    introAssetId: body.introAssetId ?? null,
    outroAssetId: body.outroAssetId ?? null,
  })
  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/brand-kits', summary: 'Kits de marca', tag: 'brand' }, async ({ user, params }) => {
    await requireMember(deps, user.id, params.ws!)
    return (await deps.db.brandKit.findMany({ where: { workspaceId: params.ws! }, orderBy: { createdAt: 'asc' } })).map(brandOut)
  })
  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/brand-kits', summary: 'Criar kit de marca', tag: 'brand', body: BrandKitBody }, async ({ user, params, body }) => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    await assertWorkspaceAssets(deps, params.ws!, [body.logoAssetId, body.watermarkAssetId], 'IMAGE')
    await assertWorkspaceAssets(deps, params.ws!, [body.introAssetId, body.outroAssetId])
    const b = await deps.db.brandKit.create({ data: { workspaceId: params.ws!, ...brandData(body) } })
    return brandOut(b)
  })
  route(app, deps, { method: 'PUT', url: '/api/brand-kits/:id', summary: 'Atualizar kit de marca', tag: 'brand', body: BrandKitBody }, async ({ user, params, body }) => {
    const b = await ownedBy(deps, user.id, await deps.db.brandKit.findUnique({ where: { id: params.id! } }), 'Kit de marca', 'EDITOR')
    await assertWorkspaceAssets(deps, b.workspaceId, [body.logoAssetId, body.watermarkAssetId], 'IMAGE')
    await assertWorkspaceAssets(deps, b.workspaceId, [body.introAssetId, body.outroAssetId])
    return brandOut(await deps.db.brandKit.update({ where: { id: b.id }, data: brandData(body) }))
  })
  route(app, deps, { method: 'DELETE', url: '/api/brand-kits/:id', summary: 'Excluir kit de marca', tag: 'brand' }, async ({ user, params }) => {
    const b = await ownedBy(deps, user.id, await deps.db.brandKit.findUnique({ where: { id: params.id! } }), 'Kit de marca', 'EDITOR')
    await deps.db.brandKit.delete({ where: { id: b.id } })
    return { ok: true }
  })

  // ------------------------------------------------------------ personagens
  const charOut = async (c: Prisma.CharacterProfileGetPayload<{ include: { references: { include: { asset: true } } } }>) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    appearance: c.appearance,
    wardrobe: c.wardrobe,
    palette: c.palette,
    mustKeep: c.mustKeep,
    continuityRules: c.continuityRules,
    voiceProfileId: c.voiceProfileId,
    references: await Promise.all(c.references.map(async (r) => ({ assetId: r.assetId, authorization: r.authorization, asset: await assetDto(deps, r.asset) }))),
  })
  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/characters', summary: 'Fichas de personagens', tag: 'characters' }, async ({ user, params }) => {
    await requireMember(deps, user.id, params.ws!)
    const rows = await deps.db.characterProfile.findMany({ where: { workspaceId: params.ws! }, include: { references: { include: { asset: true } } }, orderBy: { createdAt: 'asc' } })
    return Promise.all(rows.map(charOut))
  })
  const saveCharacter = async (ws: string, body: z.infer<typeof CharacterBody>, id?: string) => {
    await assertWorkspaceAssets(deps, ws, body.references.map((r) => r.assetId), 'IMAGE')
    if (body.voiceProfileId) {
      const v = await deps.db.voiceProfile.findFirst({ where: { id: body.voiceProfileId, workspaceId: ws } })
      if (!v) throw new HttpError(400, 'voice_invalid', 'Voz não encontrada neste espaço de trabalho.')
    }
    const data = { name: body.name, description: body.description, appearance: body.appearance, wardrobe: body.wardrobe, palette: body.palette, mustKeep: body.mustKeep, continuityRules: body.continuityRules, voiceProfileId: body.voiceProfileId ?? null }
    return deps.db.$transaction(async (tx) => {
      const c = id ? await tx.characterProfile.update({ where: { id }, data }) : await tx.characterProfile.create({ data: { workspaceId: ws, ...data } })
      await tx.characterReference.deleteMany({ where: { characterId: c.id } })
      if (body.references.length) await tx.characterReference.createMany({ data: body.references.map((r) => ({ characterId: c.id, assetId: r.assetId, authorization: r.authorization })) })
      return tx.characterProfile.findUniqueOrThrow({ where: { id: c.id }, include: { references: { include: { asset: true } } } })
    })
  }
  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/characters', summary: 'Criar personagem', tag: 'characters', body: CharacterBody }, async ({ user, params, body }) => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    return charOut(await saveCharacter(params.ws!, body))
  })
  route(app, deps, { method: 'PUT', url: '/api/characters/:id', summary: 'Atualizar personagem', tag: 'characters', body: CharacterBody }, async ({ user, params, body }) => {
    const c = await ownedBy(deps, user.id, await deps.db.characterProfile.findUnique({ where: { id: params.id! } }), 'Personagem', 'EDITOR')
    return charOut(await saveCharacter(c.workspaceId, body, c.id))
  })
  route(app, deps, { method: 'DELETE', url: '/api/characters/:id', summary: 'Excluir personagem', tag: 'characters' }, async ({ user, params }) => {
    const c = await ownedBy(deps, user.id, await deps.db.characterProfile.findUnique({ where: { id: params.id! } }), 'Personagem', 'EDITOR')
    await deps.db.characterProfile.delete({ where: { id: c.id } })
    return { ok: true }
  })

  // ------------------------------------------------------------ vozes
  route(app, deps, { method: 'GET', url: '/api/voices/catalog', summary: 'Catálogo de vozes do provedor', tag: 'voices', query: z.object({ provider: z.string() }) }, async ({ query }) => {
    const a = findTts(query.provider, deps.env)
    if (!a) throw notFound('Provedor')
    if (!a.status(deps.env).configured) throw new HttpError(409, 'provider_not_configured', 'Integração de voz com configuração pendente.')
    return { models: a.models(), voices: await a.voices(deps.env) }
  })
  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/voice-profiles', summary: 'Vozes salvas do espaço de trabalho', tag: 'voices' }, async ({ user, params }) => {
    await requireMember(deps, user.id, params.ws!)
    return deps.db.voiceProfile.findMany({ where: { workspaceId: params.ws! }, orderBy: { createdAt: 'asc' } })
  })
  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/voice-profiles', summary: 'Salvar voz (clone exige consentimento registrado)', tag: 'voices', body: VoiceProfileBody.extend({ pronunciation: z.record(z.string().max(60), z.string().max(120)).optional() }) }, async ({ user, params, body, req }) => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    if (body.isClone && !body.consent) throw new HttpError(400, 'consent_required', 'Voz clonada exige autorização registrada do titular da voz.')
    const v = await deps.db.voiceProfile.create({
      data: {
        workspaceId: params.ws!,
        name: body.name,
        provider: body.provider,
        providerVoiceId: body.providerVoiceId,
        language: body.language,
        settings: { ...body.settings, pronunciation: body.pronunciation ?? {} },
        isClone: body.isClone,
        consent: (body.consent ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
    if (body.isClone) await audit(deps.db, { workspaceId: params.ws, userId: user.id, action: 'voice.clone_consent', targetType: 'voice', targetId: v.id, meta: { speaker: body.consent?.speakerName, grantedBy: body.consent?.grantedBy }, ip: req.ip })
    return v
  })
  route(app, deps, { method: 'DELETE', url: '/api/voice-profiles/:id', summary: 'Excluir voz salva', tag: 'voices' }, async ({ user, params }) => {
    const v = await ownedBy(deps, user.id, await deps.db.voiceProfile.findUnique({ where: { id: params.id! } }), 'Voz', 'EDITOR')
    await deps.db.voiceProfile.delete({ where: { id: v.id } })
    return { ok: true }
  })

  // ------------------------------------------------------------ música
  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/music', summary: 'Biblioteca musical (catálogo licenciado + uploads)', tag: 'music', query: MusicQuery }, async ({ user, params, query }) => {
    await requireMember(deps, user.id, params.ws!)
    const where: Prisma.MusicTrackWhereInput = {
      OR: [{ workspaceId: null }, { workspaceId: params.ws! }],
      ...(query.sfx ? { isSfx: query.sfx === 'true' } : {}),
      ...(query.mood ? { mood: { contains: query.mood, mode: 'insensitive' } } : {}),
      ...(query.genre ? { genre: { contains: query.genre, mode: 'insensitive' } } : {}),
      ...(query.q ? { AND: [{ OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { artist: { contains: query.q, mode: 'insensitive' } }, { mood: { contains: query.q, mode: 'insensitive' } }, { genre: { contains: query.q, mode: 'insensitive' } }] }] } : {}),
      ...(query.minBpm || query.maxBpm ? { bpm: { ...(query.minBpm ? { gte: query.minBpm } : {}), ...(query.maxBpm ? { lte: query.maxBpm } : {}) } } : {}),
      ...(query.minSeconds || query.maxSeconds
        ? { durationFlicks: { ...(query.minSeconds ? { gte: BigInt(Math.round(query.minSeconds * 705_600_000)) } : {}), ...(query.maxSeconds ? { lte: BigInt(Math.round(query.maxSeconds * 705_600_000)) } : {}) } }
        : {}),
      ...(query.favorites === 'true' ? { favorites: { some: { userId: user.id } } } : {}),
    }
    const rows = await deps.db.musicTrack.findMany({ where, include: { license: true, asset: true, favorites: { where: { userId: user.id } } }, orderBy: [{ isSfx: 'asc' }, { title: 'asc' }], take: 300 })
    return Promise.all(
      rows.map(async (m) => ({
        id: m.id,
        title: m.title,
        artist: m.artist,
        genre: m.genre,
        mood: m.mood,
        bpm: m.bpm,
        isSfx: m.isSfx,
        durationFlicks: toNum(m.durationFlicks),
        assetId: m.assetId,
        url: await deps.storage.presignGet(m.asset.storageKey, 3600),
        favorite: m.favorites.length > 0,
        mine: m.workspaceId !== null,
        license: {
          source: m.license.source,
          author: m.license.author,
          licenseName: m.license.licenseName,
          licenseUrl: m.license.licenseUrl,
          commercialUse: m.license.commercialUse,
          attributionRequired: m.license.attributionRequired,
          attributionText: m.license.attributionText,
          platformRestrictions: m.license.platformRestrictions,
          validUntil: m.license.validUntil?.toISOString() ?? null,
        },
      })),
    )
  })
  route(app, deps, { method: 'POST', url: '/api/music/:id/favorite', summary: 'Favoritar faixa', tag: 'music' }, async ({ user, params }) => {
    const m = await deps.db.musicTrack.findUnique({ where: { id: params.id! } })
    if (!m) throw notFound('Faixa', 'f')
    if (m.workspaceId) await requireMember(deps, user.id, m.workspaceId).catch(() => {
      throw notFound('Faixa', 'f')
    })
    await deps.db.musicFavorite.upsert({ where: { userId_musicTrackId: { userId: user.id, musicTrackId: m.id } }, create: { userId: user.id, musicTrackId: m.id }, update: {} })
    return { ok: true }
  })
  route(app, deps, { method: 'DELETE', url: '/api/music/:id/favorite', summary: 'Remover favorito', tag: 'music' }, async ({ user, params }) => {
    await deps.db.musicFavorite.deleteMany({ where: { userId: user.id, musicTrackId: params.id! } })
    return { ok: true }
  })
  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/music', summary: 'Registrar música própria (com declaração de licença)', tag: 'music', body: RegisterUserMusicBody }, async ({ user, params, body, req }) => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    const a = await deps.db.asset.findFirst({ where: { id: body.assetId, workspaceId: params.ws!, kind: 'AUDIO', status: 'READY', deletedAt: null } })
    if (!a) throw new HttpError(400, 'asset_invalid', 'Áudio não encontrado ou ainda em processamento.')
    const t = await deps.db.$transaction(async (tx) => {
      const lic = await tx.licenseRecord.create({
        data: { source: 'Upload do usuário (declaração de direitos)', author: body.artist || 'Não informado', licenseName: body.license.licenseName, commercialUse: body.license.commercialUse, attributionRequired: body.license.attributionRequired, attributionText: body.license.attributionText ?? null, platformRestrictions: body.license.platformRestrictions ?? null },
      })
      return tx.musicTrack.create({ data: { workspaceId: params.ws!, assetId: a.id, licenseRecordId: lic.id, title: body.title, artist: body.artist, genre: body.genre, mood: body.mood, bpm: body.bpm ?? null, isSfx: body.isSfx, durationFlicks: a.durationFlicks ?? 0n } })
    })
    await audit(deps.db, { workspaceId: params.ws, userId: user.id, action: 'music.register', targetType: 'music', targetId: t.id, meta: { license: body.license.licenseName }, ip: req.ip })
    return { id: t.id }
  })

  // ------------------------------------------------------------ provedores e consumo
  route(app, deps, { method: 'GET', url: '/api/providers', summary: 'Estado e capacidades das integrações (sem segredos)', tag: 'providers' }, async () => {
    const env = deps.env
    const mockOn = env.PROVIDERS_MOCK === '1'
    const keep = <T extends { id: string }>(l: T[]) => l.filter((a) => !a.id.startsWith('mock-') || mockOn)
    return {
      statuses: providerStatuses(env),
      video: keep(VIDEO_ADAPTERS).map((a) => ({ id: a.id, label: a.label, models: a.models(), configured: a.status(env).configured, mode: a.status(env).mode })),
      image: keep(IMAGE_ADAPTERS).map((a) => ({ id: a.id, label: a.label, models: a.models(), configured: a.status(env).configured, mode: a.status(env).mode })),
      tts: keep(TTS_ADAPTERS).map((a) => ({ id: a.id, label: a.label, models: a.models(), configured: a.status(env).configured, mode: a.status(env).mode })),
      transcription: keep(TRANSCRIPTION_ADAPTERS).map((a) => ({ id: a.id, label: a.label, models: a.models(), configured: a.status(env).configured, mode: a.status(env).mode })),
      translation: (() => {
        const t = translationAdapter(env)
        return t ? { configured: true, label: t.label, mode: t.status(env).mode } : { configured: false, label: 'Anthropic Claude', mode: 'pending-config' }
      })(),
    }
  })
  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/usage', summary: 'Consumo do mês (estimado × confirmado)', tag: 'usage' }, async ({ user, params }) => {
    await requireMember(deps, user.id, params.ws!)
    const ws = await deps.db.workspace.findUniqueOrThrow({ where: { id: params.ws! } })
    const spend = await monthlySpend(deps.db, ws.id)
    const entries = await deps.db.usageLedger.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'desc' }, take: 100 })
    const storage = await deps.db.asset.aggregate({ where: { workspaceId: ws.id, deletedAt: null }, _sum: { sizeBytes: true } })
    return {
      budgetCents: ws.generationBudgetCents,
      confirmedCents: spend.confirmed,
      estimatedPendingCents: spend.estimatedPending,
      storageUsedBytes: toNum(storage._sum.sizeBytes) ?? 0,
      storageQuotaBytes: toNum(ws.quotaBytes),
      entries: entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    }
  })
  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/audit', summary: 'Eventos de auditoria (proprietário)', tag: 'usage' }, async ({ user, params }) => {
    await requireMember(deps, user.id, params.ws!, 'OWNER')
    const rows = await deps.db.auditEvent.findMany({ where: { workspaceId: params.ws! }, orderBy: { createdAt: 'desc' }, take: 200 })
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
  })

  // ------------------------------------------------------------ assistente
  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/assistant/plan', summary: 'Gerar plano criativo (aberturas, roteiro, storyboard)', tag: 'assistant', body: z.object({ brief: AssistantBrief, maxSceneSeconds: z.number().min(2).max(60).default(8) }), rateLimit: { max: 20, timeWindow: '1 minute' } }, async ({ user, params, body }) => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    const llm = scriptAdapter(deps.env)
    if (llm) {
      try {
        return await llmPlan(llm, deps.env, body.brief, body.maxSceneSeconds)
      } catch (err) {
        const local = localPlan(body.brief, body.maxSceneSeconds)
        local.notes.unshift(`IA indisponível (${(err as Error).message.slice(0, 120)}); usando organizador local.`)
        return local
      }
    }
    return localPlan(body.brief, body.maxSceneSeconds)
  })
  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/assistant/command', summary: 'Interpretar comando em comandos estruturados (prévia)', tag: 'assistant', body: AssistantCommandBody }, async ({ user, params, body }) => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    const ws = params.ws!
    const music = await deps.db.musicTrack.findMany({ where: { OR: [{ workspaceId: null }, { workspaceId: ws }], isSfx: false }, take: 50 })
    const brand = await deps.db.brandKit.findMany({ where: { workspaceId: ws }, select: { id: true } })
    const voices = await deps.db.voiceProfile.findMany({ where: { workspaceId: ws }, select: { id: true, name: true } })
    const local = parseCommand(body.document, body.command, {
      selectedClipId: body.selectedClipId,
      playhead: body.playhead,
      music: music.map((m) => ({ id: m.id, assetId: m.assetId, durationFlicks: Number(m.durationFlicks), title: m.title })),
      brandKitIds: brand.map((b) => b.id),
      voices,
    })
    if (local.understood) return { ...local, source: 'local' }
    const llm = scriptAdapter(deps.env)
    if (!llm) return { ...local, source: 'local' }
    const summary = body.document.tracks.map((t) => `${t.kind} ${t.id}: ${t.clips.map((c) => `${c.id} "${c.name}" ${c.start}+${c.duration}`).join(', ')}`).join('\n')
    try {
      const commands = await llmCommand(llm, deps.env, body.command, summary)
      return { commands, summary: `Interpretado por IA: ${commands.length} comando(s). Revise a prévia.`, requiresPaidGeneration: false, understood: commands.length > 0, source: 'llm' }
    } catch {
      return { ...local, source: 'local' }
    }
  })

  // ------------------------------------------------------------ webhooks
  app.post('/api/webhooks/:provider', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const provider = (req.params as { provider: string }).provider
    if (!/^[a-z0-9-]{2,40}$/.test(provider)) return reply.code(404).send()
    const secret = deps.env[`WEBHOOK_SECRET_${provider.toUpperCase().replace(/-/g, '_')}`]
    if (!secret) return reply.code(404).send({ error: { code: 'webhook_disabled', message: 'Webhook não configurado.' } })
    const raw = JSON.stringify(req.body ?? {})
    const sig = String(req.headers['x-orion-signature'] ?? '')
    const expected = createHmac('sha256', secret).update(raw).digest('hex')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: { code: 'invalid_signature', message: 'Assinatura inválida.' } })
    const remoteId = String((req.body as { remoteId?: string })?.remoteId ?? '')
    const g = await deps.db.generationJob.findFirst({ where: { provider, remoteId } })
    if (g && (g.status === 'running' || g.status === 'queued')) {
      // não confia no payload: apenas agenda reconciliação com o provedor
      await deps.queues.generation.add('poll', { generationJobId: g.id, phase: 'poll' }, { jobId: `gen-${g.id}-hook-${Date.now()}` })
    }
    return { ok: true }
  })
}
