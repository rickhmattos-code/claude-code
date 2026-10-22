import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { type GenerationJob, Prisma } from '@orion/db'
import { probeFile, runFfmpeg } from '@orion/media'
import { ProviderError, findImage, findTranscription, findTts, findVideo, pricingFor } from '@orion/providers'
import { objectKey } from '@orion/server'
import type { CaptionSegment, GenerationRequest } from '@orion/shared'
import { captionsFromCharAlignment, newId, secondsToFlicks, wordsToSegments } from '@orion/timeline'
import type { WorkerContext } from '../context.ts'

/**
 * Gerações por IA.
 *  - Operações longas (vídeo): start grava o ID remoto ANTES de qualquer nova
 *    tentativa; retries e reinícios consultam o status remoto em vez de
 *    pedir outra geração (evita cobrança duplicada).
 *  - Operações síncronas (imagem, voz, transcrição): um marcador
 *    externalCallStartedAt é gravado antes da chamada. Se o worker cair no
 *    meio, a nova tentativa NÃO repete a chamada automaticamente: falha com
 *    mensagem pedindo confirmação do usuário (possível cobrança anterior).
 */

const POLL_DELAY_MS = 5000
const POLL_TIMEOUT_MS = 30 * 60_000

type Input = GenerationRequest & Record<string, unknown>

async function finishLedger(ctx: WorkerContext, job: GenerationJob, confirmedCents: number | null, ok: boolean) {
  await ctx.db.usageLedger.updateMany({
    where: { jobId: job.id, kind: job.kind },
    data: ok ? { status: 'CONFIRMED', confirmedCents: confirmedCents ?? job.estimatedCostCents } : { status: 'VOID' },
  })
}

async function markFailed(ctx: WorkerContext, job: GenerationJob, message: string) {
  await ctx.db.generationJob.update({ where: { id: job.id }, data: { status: 'failed', error: message.slice(0, 1000) } })
  await finishLedger(ctx, job, null, false)
  ctx.log('generation.failed', { id: job.id, provider: job.provider, message: message.slice(0, 200) })
}

async function storeAsset(ctx: WorkerContext, job: GenerationJob, path: string, mime: string, ext: string, source: 'GENERATED' | 'TTS', name: string) {
  const id = crypto.randomUUID()
  const key = objectKey.upload(job.workspaceId, id, ext)
  const info = await probeFile(path)
  await ctx.storage.upload(key, path, mime)
  const size = (await stat(path)).size
  await ctx.db.asset.create({
    data: {
      id,
      workspaceId: job.workspaceId,
      kind: info.kind,
      status: 'PROCESSING',
      source,
      storageKey: key,
      mimeType: mime,
      sizeBytes: BigInt(size),
      originalName: name.slice(0, 200),
      durationFlicks: info.durationFlicks === null ? null : BigInt(info.durationFlicks),
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      hasVideo: info.kind === 'VIDEO',
    },
  })
  // miniatura/onda/proxy pelo pipeline normal de ingestão
  await ctx.queues.media.add('ingest', { type: 'ingest', assetId: id }, { jobId: `ingest-${id}` })
  return { id, info }
}

export async function runGenerationJob(ctx: WorkerContext, data: { generationJobId: string; phase: 'start' | 'poll' }, attempt: number, maxAttempts: number) {
  const job = await ctx.db.generationJob.findUnique({ where: { id: data.generationJobId } })
  if (!job || job.status === 'succeeded' || job.status === 'failed') return
  const env = ctx.env
  const input = job.input as unknown as Input
  const dir = join(ctx.tmpDir, 'gen', job.id)
  await mkdir(dir, { recursive: true })
  try {
    if (job.status === 'canceled') {
      if (job.kind === 'VIDEO' && job.remoteId) await findVideo(job.provider, env)?.cancel?.(job.remoteId, env).catch(() => false)
      await finishLedger(ctx, job, null, false)
      return
    }
    if (job.kind === 'VIDEO') return await runVideo(ctx, job, input as Extract<Input, { kind: 'VIDEO' }>, dir, data.phase)
    const result = job.result as { externalCallStartedAt?: string } | null
    if (result?.externalCallStartedAt) {
      return await markFailed(ctx, job, 'A tentativa anterior foi interrompida após chamar o provedor; para evitar cobrança duplicada, confirme e gere novamente.')
    }
    await ctx.db.generationJob.update({ where: { id: job.id }, data: { status: 'running', attempts: { increment: 1 }, result: { externalCallStartedAt: new Date().toISOString() } } })
    if (job.kind === 'IMAGE') await runImage(ctx, job, input as Extract<Input, { kind: 'IMAGE' }>, dir)
    else if (job.kind === 'TTS') await runTts(ctx, job, input as Extract<Input, { kind: 'TTS' }>, dir)
    else if (job.kind === 'TRANSCRIPTION') await runTranscription(ctx, job, input as Extract<Input, { kind: 'TRANSCRIPTION' }>, dir)
  } catch (err) {
    // repete só quando o provedor respondeu explicitamente (429/5xx = não processado);
    // falha de rede/timeout em chamada síncrona é ambígua (pode ter sido cobrada)
    const safeToRetry = err instanceof ProviderError && err.retryable && (job.kind === 'VIDEO' || err.httpStatus !== undefined)
    if (safeToRetry && attempt + 1 < maxAttempts) {
      if (job.kind !== 'VIDEO') await ctx.db.generationJob.update({ where: { id: job.id }, data: { result: Prisma.DbNull, status: 'queued', error: (err as Error).message } })
      throw err
    }
    await markFailed(ctx, job, err instanceof ProviderError ? `${err.message}` : `Erro: ${(err as Error).message}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runVideo(ctx: WorkerContext, job: GenerationJob, input: Extract<Input, { kind: 'VIDEO' }>, dir: string, phase: 'start' | 'poll') {
  const env = ctx.env
  const adapter = findVideo(job.provider, env)
  if (!adapter || !adapter.status(env).configured) return markFailed(ctx, job, 'Integração com configuração pendente.')
  let remoteId = job.remoteId
  if (!remoteId) {
    if (phase === 'poll') return
    let image: { bytes: Buffer; mimeType: string } | undefined
    if (input.imageAssetId) {
      const img = await ctx.db.asset.findUniqueOrThrow({ where: { id: input.imageAssetId } })
      const p = join(dir, 'input-image')
      await ctx.storage.download(img.storageKey, p)
      image = { bytes: await readFile(p), mimeType: img.mimeType }
    }
    const started = await adapter.start({ model: job.model, mode: input.mode, prompt: input.prompt, negativePrompt: input.negativePrompt, durationSeconds: input.durationSeconds, aspect: input.aspect, resolution: input.resolution, seed: input.seed, image }, env)
    remoteId = started.remoteId
    // grava o ID remoto imediatamente (base da reconciliação)
    await ctx.db.generationJob.update({ where: { id: job.id }, data: { remoteId, status: 'running', attempts: { increment: 1 } } })
    await ctx.queues.generation.add('poll', { generationJobId: job.id, phase: 'poll' }, { jobId: `gen-${job.id}-poll-${Date.now()}`, delay: POLL_DELAY_MS })
    return
  }
  const poll = await adapter.poll(remoteId, env)
  if (poll.state === 'running') {
    if (Date.now() - job.createdAt.getTime() > POLL_TIMEOUT_MS) {
      return markFailed(ctx, job, `Tempo limite de consulta excedido (operação remota ${remoteId}). Verifique no console do provedor antes de repetir.`)
    }
    await ctx.queues.generation.add('poll', { generationJobId: job.id, phase: 'poll' }, { jobId: `gen-${job.id}-poll-${Date.now()}`, delay: POLL_DELAY_MS })
    return
  }
  if (poll.state === 'failed') return markFailed(ctx, job, poll.error ?? 'Falha no provedor')
  const out = join(dir, 'video.mp4')
  await adapter.download(poll.result, out, env)
  const { id, info } = await storeAsset(ctx, job, out, 'video/mp4', '.mp4', 'GENERATED', `IA — ${input.prompt.slice(0, 60)}`)
  const secs = (info.durationFlicks ?? 0) / 705_600_000
  const pricing = pricingFor(env, job.provider, job.model)
  const confirmed = pricing?.perSecondCents != null ? Math.ceil(pricing.perSecondCents * Math.round(secs)) : job.estimatedCostCents
  await ctx.db.generationJob.update({ where: { id: job.id }, data: { status: 'succeeded', resultAssetId: id, confirmedCostCents: confirmed, result: { remoteId, durationFlicks: info.durationFlicks } } })
  await finishLedger(ctx, job, confirmed, true)
  ctx.log('generation.succeeded', { id: job.id, kind: 'VIDEO' })
}

async function runImage(ctx: WorkerContext, job: GenerationJob, input: Extract<Input, { kind: 'IMAGE' }>, dir: string) {
  const adapter = findImage(job.provider, ctx.env)
  if (!adapter || !adapter.status(ctx.env).configured) return markFailed(ctx, job, 'Integração com configuração pendente.')
  const out = join(dir, 'image.png')
  await adapter.generate({ model: job.model, prompt: input.prompt, aspect: input.aspect }, out, ctx.env)
  const { id } = await storeAsset(ctx, job, out, 'image/png', '.png', 'GENERATED', `IA — ${input.prompt.slice(0, 60)}`)
  await ctx.db.generationJob.update({ where: { id: job.id }, data: { status: 'succeeded', resultAssetId: id, confirmedCostCents: job.estimatedCostCents, result: {} } })
  await finishLedger(ctx, job, job.estimatedCostCents, true)
}

async function runTts(ctx: WorkerContext, job: GenerationJob, input: Extract<Input, { kind: 'TTS' }>, dir: string) {
  const adapter = findTts(job.provider, ctx.env)
  if (!adapter || !adapter.status(ctx.env).configured) return markFailed(ctx, job, 'Integração com configuração pendente.')
  const raw = join(dir, 'tts-raw')
  const r = await adapter.synthesize({ model: job.model, voiceId: input.voiceId, text: input.text, speed: input.speed }, raw, ctx.env)
  // padroniza em M4A/AAC 48 kHz
  const out = join(dir, 'tts.m4a')
  await runFfmpeg(['-i', raw, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', out], { timeoutMs: 120_000 })
  const { id, info } = await storeAsset(ctx, job, out, 'audio/mp4', '.m4a', 'TTS', `Narração — ${input.text.slice(0, 60)}`)
  const duration = info.durationFlicks ?? 0
  let captions: CaptionSegment[]
  let timing: 'provider' | 'sentence'
  if (r.alignment) {
    captions = captionsFromCharAlignment(r.alignment.characters, r.alignment.starts, r.alignment.ends)
    timing = 'provider'
  } else {
    // sem timestamps do provedor: um segmento com os limites reais do áudio (sem palavra a palavra)
    captions = [{ id: newId(), start: 0, end: Math.max(1, duration), text: input.text }]
    timing = 'sentence'
  }
  await ctx.db.generationJob.update({ where: { id: job.id }, data: { status: 'succeeded', resultAssetId: id, confirmedCostCents: job.estimatedCostCents, result: { durationFlicks: duration, captions, timing } as unknown as Prisma.InputJsonValue } })
  await finishLedger(ctx, job, job.estimatedCostCents, true)
}

async function runTranscription(ctx: WorkerContext, job: GenerationJob, input: Extract<Input, { kind: 'TRANSCRIPTION' }>, dir: string) {
  const adapter = findTranscription(job.provider, ctx.env)
  if (!adapter || !adapter.status(ctx.env).configured) return markFailed(ctx, job, 'Integração com configuração pendente.')
  const asset = await ctx.db.asset.findUniqueOrThrow({ where: { id: input.assetId } })
  const src = join(dir, `src${asset.storageKey.slice(asset.storageKey.lastIndexOf('.'))}`)
  await ctx.storage.download(asset.storageKey, src)
  // áudio mono 16 kHz MP3 em blocos de 10 min (limite de 25 MB do provedor)
  const total = Number(asset.durationFlicks ?? 0n) / 705_600_000
  const block = 600
  const segments: CaptionSegment[] = []
  const allWords: Array<{ text: string; start: number; end: number }> = []
  let hasWords = true
  for (let off = 0; off < total; off += block) {
    const part = join(dir, `part-${off}.mp3`)
    await runFfmpeg(['-ss', String(off), '-t', String(block), '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', part], { timeoutMs: 10 * 60_000 })
    const r = await adapter.transcribe({ model: job.model, path: part, language: input.language }, ctx.env)
    if (r.words) for (const w of r.words) allWords.push({ text: w.text, start: secondsToFlicks(w.start + off), end: secondsToFlicks(w.end + off) })
    else hasWords = false
    for (const s of r.segments) segments.push({ id: newId(), start: secondsToFlicks(s.start + off), end: secondsToFlicks(s.end + off), text: s.text, ...(s.speaker ? { speaker: s.speaker } : {}) })
  }
  const captions = hasWords && allWords.length ? wordsToSegments(allWords) : segments
  await ctx.db.generationJob.update({ where: { id: job.id }, data: { status: 'succeeded', confirmedCostCents: job.estimatedCostCents, result: { captions, wordTimestamps: hasWords && allWords.length > 0 } as unknown as Prisma.InputJsonValue } })
  await finishLedger(ctx, job, job.estimatedCostCents, true)
}
