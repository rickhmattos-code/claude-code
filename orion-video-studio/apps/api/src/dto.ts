import type { Asset, RenderJob, GenerationJob } from '@orion/db'
import { toNum } from '@orion/db'
import type { Deps } from './core.ts'

/** URLs temporárias (1 h) para leitura de mídia. */
const URL_TTL = 3600

export async function assetDto(deps: Deps, a: Asset) {
  const url = (key: string | null, name?: string) => (key ? deps.storage.presignGet(key, URL_TTL, name) : Promise.resolve(null))
  const ready = a.status === 'READY'
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    kind: a.kind,
    status: a.status,
    source: a.source,
    mimeType: a.mimeType,
    sizeBytes: toNum(a.sizeBytes),
    originalName: a.originalName,
    durationFlicks: toNum(a.durationFlicks),
    width: a.width,
    height: a.height,
    fps: a.fpsNum && a.fpsDen ? { num: a.fpsNum, den: a.fpsDen } : null,
    variableFrameRate: a.variableFrameRate,
    rotation: a.rotation,
    hasVideo: a.hasVideo,
    hasAudio: a.hasAudio,
    sampleRate: a.sampleRate,
    channels: a.channels,
    error: a.error,
    createdAt: a.createdAt.toISOString(),
    originalUrl: ready || a.kind === 'IMAGE' ? await url(a.storageKey) : null,
    proxyUrl: await url(a.proxyKey),
    proxyWebmUrl: a.proxyKey ? await url(a.proxyKey.replace(/proxy\.(mp4|m4a)$/, 'proxy.webm')) : null,
    thumbnailUrl: await url(a.thumbnailKey),
    waveformUrl: await url(a.waveformKey),
  }
}

export function renderDto(r: RenderJob) {
  return {
    id: r.id,
    projectId: r.projectId,
    revisionId: r.revisionId,
    status: r.status,
    progress: r.progress,
    stage: r.stage,
    preset: r.preset,
    outputAssetId: r.outputAssetId,
    captionsAssetId: r.captionsAssetId,
    validation: r.validation,
    error: r.error,
    attempts: r.attempts,
    cancelRequested: r.cancelRequested,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }
}

export function generationDto(g: GenerationJob) {
  return {
    id: g.id,
    projectId: g.projectId,
    kind: g.kind,
    provider: g.provider,
    model: g.model,
    status: g.status,
    input: g.input,
    sceneKey: g.sceneKey,
    estimatedCostCents: g.estimatedCostCents,
    confirmedCostCents: g.confirmedCostCents,
    resultAssetId: g.resultAssetId,
    result: g.result,
    error: g.error,
    attempts: g.attempts,
    approved: g.approved,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }
}
