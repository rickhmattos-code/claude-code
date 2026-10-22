import { Queue, type ConnectionOptions } from 'bullmq'
import IORedis from 'ioredis'

/**
 * Filas (BullMQ/Redis). Processamentos longos NUNCA rodam no ciclo HTTP:
 * a API grava o registro (RenderJob/GenerationJob/Asset) e enfileira; o
 * worker executa, atualiza o banco e a interface acompanha por polling.
 * IDs de job são determinísticos → reenfileirar é idempotente.
 */

export const QUEUES = {
  media: 'orion-media',
  render: 'orion-render',
  generation: 'orion-generation',
  maintenance: 'orion-maintenance',
} as const

export type MediaJob =
  | { type: 'ingest'; assetId: string }
  | { type: 'reverse'; assetId: string; sourceAssetId: string; sourceIn: number; duration: number }
  | { type: 'freeze'; assetId: string; sourceAssetId: string; at: number }
  | { type: 'extract-audio'; assetId: string; sourceAssetId: string }
  | { type: 'silence'; assetId: string; requestId: string }

export type RenderJobData = { renderJobId: string }
export type GenerationJobData = { generationJobId: string; phase: 'start' | 'poll' }
export type MaintenanceJob = { type: 'cleanup' | 'gc' | 'reconcile' }

export function redisConnection(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true })
}

export interface Queues {
  media: Queue<MediaJob>
  render: Queue<RenderJobData>
  generation: Queue<GenerationJobData>
  maintenance: Queue<MaintenanceJob>
  close(): Promise<void>
}

export function createQueues(connection: ConnectionOptions): Queues {
  const defaultJobOptions = { removeOnComplete: { age: 7 * 24 * 3600, count: 1000 }, removeOnFail: { age: 30 * 24 * 3600 } }
  const media = new Queue<MediaJob>(QUEUES.media, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 3, backoff: { type: 'exponential', delay: 5000 } } })
  const render = new Queue<RenderJobData>(QUEUES.render, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } } })
  const generation = new Queue<GenerationJobData>(QUEUES.generation, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 5, backoff: { type: 'exponential', delay: 5000 } } })
  const maintenance = new Queue<MaintenanceJob>(QUEUES.maintenance, { connection, defaultJobOptions })
  return {
    media,
    render,
    generation,
    maintenance,
    async close() {
      await Promise.all([media.close(), render.close(), generation.close(), maintenance.close()])
    },
  }
}
