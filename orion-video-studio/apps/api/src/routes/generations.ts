import { createHash } from 'node:crypto'
import type { Prisma } from '@orion/db'
import { toNum } from '@orion/db'
import {
  type Estimate,
  applyPronunciation,
  findImage,
  findTranscription,
  findTts,
  findVideo,
  pricingFor,
} from '@orion/providers'
import { audit, monthlySpend } from '@orion/server'
import { CreateGenerationBody, type EstimateResponse, GenerationRequest } from '@orion/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type Deps, HttpError, notFound, requireMember, route } from '../core.ts'
import { generationDto } from '../dto.ts'

interface Resolved {
  configured: boolean
  estimate: Estimate
  finalInput: Record<string, unknown>
}

function characterPrompt(c: { name: string; appearance: string; wardrobe: string; mustKeep: unknown; continuityRules: string; palette: unknown }): string {
  const keep = Array.isArray(c.mustKeep) && c.mustKeep.length ? ` Manter sempre: ${(c.mustKeep as string[]).join('; ')}.` : ''
  const pal = Array.isArray(c.palette) && c.palette.length ? ` Paleta: ${(c.palette as string[]).join(', ')}.` : ''
  return `${c.name}: ${c.appearance}. Figurino: ${c.wardrobe}.${keep}${pal}${c.continuityRules ? ` Continuidade: ${c.continuityRules}.` : ''}`
}

/** Resolve adapter, valida capacidades, monta o prompt final e estima o custo. */
async function resolveRequest(deps: Deps, ws: string, req: GenerationRequest): Promise<Resolved> {
  const env = deps.env
  switch (req.kind) {
    case 'VIDEO': {
      const a = findVideo(req.provider, env)
      if (!a) throw new HttpError(404, 'provider_not_found', 'Provedor de vídeo desconhecido.')
      const model = a.models().find((m) => m.id === req.model)
      if (!model) throw new HttpError(400, 'model_not_found', 'Modelo indisponível para este provedor.')
      if (!model.modes.includes(req.mode)) throw new HttpError(400, 'mode_unsupported', `${model.label} não suporta ${req.mode}.`)
      if (!model.durations.includes(req.durationSeconds)) throw new HttpError(400, 'duration_unsupported', `${model.label} aceita ${model.durations.join(', ')} segundos por geração. Cenas maiores são divididas em tomadas.`)
      if (!model.resolutions.includes(req.resolution)) throw new HttpError(400, 'resolution_unsupported', `${model.label} não gera ${req.resolution}.`)
      if (req.mode === 'image-to-video' && !req.imageAssetId) throw new HttpError(400, 'image_required', 'Selecione a imagem inicial.')
      if (req.imageAssetId) {
        const img = await deps.db.asset.findFirst({ where: { id: req.imageAssetId, workspaceId: ws, kind: 'IMAGE', status: 'READY', deletedAt: null } })
        if (!img) throw new HttpError(400, 'image_invalid', 'Imagem inicial não encontrada neste workspace.')
      }
      const chars = req.characterIds.length ? await deps.db.characterProfile.findMany({ where: { id: { in: req.characterIds }, workspaceId: ws } }) : []
      if (chars.length !== req.characterIds.length) throw new HttpError(400, 'character_invalid', 'Personagem não encontrado neste workspace.')
      const prompt = chars.length ? `${req.prompt}\n\nPersonagens (manter consistência):\n${chars.map(characterPrompt).join('\n')}` : req.prompt
      return { configured: a.status(env).configured, estimate: a.estimate(req.model, req.durationSeconds, pricingFor(env, a.id, req.model)), finalInput: { ...req, prompt: prompt.slice(0, 4000) } }
    }
    case 'IMAGE': {
      const a = findImage(req.provider, env)
      if (!a) throw new HttpError(404, 'provider_not_found', 'Provedor de imagem desconhecido.')
      if (!a.models().some((m) => m.id === req.model)) throw new HttpError(400, 'model_not_found', 'Modelo indisponível.')
      const chars = req.characterIds.length ? await deps.db.characterProfile.findMany({ where: { id: { in: req.characterIds }, workspaceId: ws } }) : []
      if (chars.length !== req.characterIds.length) throw new HttpError(400, 'character_invalid', 'Personagem não encontrado neste workspace.')
      const prompt = chars.length ? `${req.prompt}\n\nPersonagens:\n${chars.map(characterPrompt).join('\n')}` : req.prompt
      return { configured: a.status(env).configured, estimate: a.estimate(req.model, pricingFor(env, a.id, req.model)), finalInput: { ...req, prompt: prompt.slice(0, 4000) } }
    }
    case 'TTS': {
      const a = findTts(req.provider, env)
      if (!a) throw new HttpError(404, 'provider_not_found', 'Provedor de voz desconhecido.')
      const model = a.models().find((m) => m.id === req.model)
      if (!model) throw new HttpError(400, 'model_not_found', 'Modelo indisponível.')
      if (req.speed < model.speedRange[0] || req.speed > model.speedRange[1]) throw new HttpError(400, 'speed_range', `Velocidade suportada: ${model.speedRange.join('–')}×.`)
      const profile = await deps.db.voiceProfile.findFirst({ where: { workspaceId: ws, provider: req.provider, providerVoiceId: req.voiceId } })
      const dict = ((profile?.settings as { pronunciation?: Record<string, string> } | null)?.pronunciation ?? {}) as Record<string, string>
      const text = applyPronunciation(req.text, dict)
      return { configured: a.status(env).configured, estimate: a.estimate(req.model, text, pricingFor(env, a.id, req.model)), finalInput: { ...req, text } }
    }
    case 'TRANSCRIPTION': {
      const a = findTranscription(req.provider, env)
      if (!a) throw new HttpError(404, 'provider_not_found', 'Provedor de transcrição desconhecido.')
      if (!a.models().some((m) => m.id === req.model)) throw new HttpError(400, 'model_not_found', 'Modelo indisponível.')
      const asset = await deps.db.asset.findFirst({ where: { id: req.assetId, workspaceId: ws, status: 'READY', deletedAt: null } })
      if (!asset?.hasAudio) throw new HttpError(400, 'asset_invalid', 'Mídia sem áudio ou não encontrada.')
      const secs = (toNum(asset.durationFlicks) ?? 0) / 705_600_000
      return { configured: a.status(env).configured, estimate: a.estimate(req.model, secs, pricingFor(env, a.id, req.model)), finalInput: { ...req } }
    }
  }
}

function inputHash(input: Record<string, unknown>): string {
  const { sceneKey: _s, sentenceKey: _k, ...rest } = input as Record<string, unknown> & { sceneKey?: unknown; sentenceKey?: unknown }
  const sorted = JSON.stringify(rest, Object.keys(rest).sort())
  return createHash('sha256').update(sorted).digest('hex')
}

async function loadGeneration(deps: Deps, userId: string, id: string) {
  const g = await deps.db.generationJob.findUnique({ where: { id } })
  if (!g) throw notFound('Geração')
  await requireMember(deps, userId, g.workspaceId).catch(() => {
    throw notFound('Geração')
  })
  return g
}

export function registerGenerations(app: FastifyInstance, deps: Deps) {
  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/generations/estimate', summary: 'Estimar custo antes de gerar', tag: 'generations', body: z.object({ request: GenerationRequest }) }, async ({ user, params, body }): Promise<EstimateResponse> => {
    await requireMember(deps, user.id, params.ws!, 'EDITOR')
    const r = await resolveRequest(deps, params.ws!, body.request)
    const ws = await deps.db.workspace.findUniqueOrThrow({ where: { id: params.ws! } })
    const spend = await monthlySpend(deps.db, ws.id)
    return {
      provider: body.request.provider,
      model: body.request.model,
      configured: r.configured,
      estimatedCents: r.estimate.cents,
      basis: r.estimate.basis,
      remainingBudgetCents: ws.generationBudgetCents - spend.confirmed - spend.estimatedPending,
    }
  })

  route(app, deps, { method: 'POST', url: '/api/workspaces/:ws/generations', summary: 'Criar geração (após aceitar a estimativa)', tag: 'generations', body: CreateGenerationBody, rateLimit: { max: 60, timeWindow: '1 minute' } }, async ({ user, params, body, req }) => {
    const ws = params.ws!
    await requireMember(deps, user.id, ws, 'EDITOR')
    const existing = await deps.db.generationJob.findUnique({ where: { idempotencyKey: body.idempotencyKey } })
    if (existing) {
      if (existing.workspaceId !== ws) throw new HttpError(409, 'idempotency_conflict', 'Chave de idempotência já usada.')
      return { ...generationDto(existing), reused: false, duplicate: true }
    }
    if (body.projectId) {
      const p = await deps.db.project.findFirst({ where: { id: body.projectId, workspaceId: ws, deletedAt: null } })
      if (!p) throw notFound('Projeto')
    }
    const r = await resolveRequest(deps, ws, body.request)
    if (!r.configured) throw new HttpError(409, 'provider_not_configured', 'Integração com configuração pendente: defina as credenciais no servidor (veja Integrações).')
    const hash = inputHash(r.finalInput)
    const approved = await deps.db.generationJob.findFirst({ where: { workspaceId: ws, inputHash: hash, status: 'succeeded', approved: true }, orderBy: { createdAt: 'desc' } })
    if (approved) return { ...generationDto(approved), reused: true, duplicate: false }
    if (r.estimate.cents === null && deps.config.ALLOW_UNPRICED_GENERATION !== '1') {
      throw new HttpError(409, 'pricing_missing', 'Não há preço confiável configurado para este modelo. Configure packages/providers/pricing.json (ou ALLOW_UNPRICED_GENERATION=1, por sua conta).')
    }
    if (body.acceptEstimatedCents !== r.estimate.cents) {
      throw new HttpError(409, 'estimate_not_accepted', 'Confirme a estimativa de custo atual antes de gerar.', { estimatedCents: r.estimate.cents, basis: r.estimate.basis })
    }
    const workspace = await deps.db.workspace.findUniqueOrThrow({ where: { id: ws } })
    const spend = await monthlySpend(deps.db, ws)
    const cents = r.estimate.cents ?? 0
    if (spend.confirmed + spend.estimatedPending + cents > workspace.generationBudgetCents) {
      throw new HttpError(402, 'budget_exceeded', 'Limite mensal de gastos com IA do workspace atingido.')
    }
    const g = await deps.db.$transaction(async (tx) => {
      const job = await tx.generationJob.create({
        data: {
          workspaceId: ws,
          projectId: body.projectId ?? null,
          kind: body.request.kind,
          provider: body.request.provider,
          model: body.request.model,
          input: r.finalInput as Prisma.InputJsonValue,
          inputHash: hash,
          idempotencyKey: body.idempotencyKey,
          sceneKey: ('sceneKey' in body.request ? body.request.sceneKey : undefined) ?? null,
          estimatedCostCents: cents,
          createdById: user.id,
        },
      })
      await tx.usageLedger.create({ data: { workspaceId: ws, jobId: job.id, kind: body.request.kind, provider: body.request.provider, quantity: 1, unit: 'job', estimatedCents: cents, status: 'ESTIMATED' } })
      return job
    })
    await deps.queues.generation.add('start', { generationJobId: g.id, phase: 'start' }, { jobId: `gen-${g.id}-start` })
    await audit(deps.db, { workspaceId: ws, userId: user.id, action: 'generation.create', targetType: 'generation', targetId: g.id, meta: { provider: g.provider, model: g.model, estimatedCents: cents }, ip: req.ip })
    return { ...generationDto(g), reused: false, duplicate: false }
  })

  route(app, deps, { method: 'GET', url: '/api/workspaces/:ws/generations', summary: 'Histórico de gerações', tag: 'generations', query: z.object({ projectId: z.string().uuid().optional(), kind: z.enum(['VIDEO', 'IMAGE', 'TTS', 'TRANSCRIPTION', 'SCRIPT', 'MUSIC']).optional() }) }, async ({ user, params, query }) => {
    await requireMember(deps, user.id, params.ws!)
    const rows = await deps.db.generationJob.findMany({ where: { workspaceId: params.ws!, ...(query.projectId ? { projectId: query.projectId } : {}), ...(query.kind ? { kind: query.kind } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 })
    return rows.map(generationDto)
  })

  route(app, deps, { method: 'GET', url: '/api/generations/:id', summary: 'Status da geração', tag: 'generations' }, async ({ user, params }) => {
    return generationDto(await loadGeneration(deps, user.id, params.id!))
  })

  route(app, deps, { method: 'POST', url: '/api/generations/:id/cancel', summary: 'Cancelar geração (quando suportado)', tag: 'generations' }, async ({ user, params }) => {
    const g = await loadGeneration(deps, user.id, params.id!)
    await requireMember(deps, user.id, g.workspaceId, 'EDITOR')
    if (g.status === 'queued' || g.status === 'running') {
      await deps.db.generationJob.update({ where: { id: g.id }, data: { status: 'canceled', error: 'Cancelado pelo usuário' } })
      await deps.queues.generation.add('poll', { generationJobId: g.id, phase: 'poll' }, { jobId: `gen-${g.id}-cancel-${Date.now()}` })
    }
    return generationDto((await deps.db.generationJob.findUnique({ where: { id: g.id } }))!)
  })

  route(app, deps, { method: 'POST', url: '/api/generations/:id/approve', summary: 'Aprovar/reprovar resultado', tag: 'generations', body: z.object({ approved: z.boolean() }) }, async ({ user, params, body }) => {
    const g = await loadGeneration(deps, user.id, params.id!)
    await requireMember(deps, user.id, g.workspaceId, 'EDITOR')
    if (g.status !== 'succeeded') throw new HttpError(409, 'not_ready', 'Só é possível aprovar resultados concluídos.')
    const upd = await deps.db.generationJob.update({ where: { id: g.id }, data: { approved: body.approved } })
    return generationDto(upd)
  })
}
