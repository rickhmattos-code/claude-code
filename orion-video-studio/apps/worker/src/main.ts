import { type Job, Worker } from 'bullmq'
import { QUEUES, type GenerationJobData, type MaintenanceJob, type MediaJob, type RenderJobData } from '@orion/server'
import { createContext } from './context.ts'
import { runGenerationJob } from './jobs/generation.ts'
import { runMaintenance } from './jobs/maintenance.ts'
import { runMediaJob } from './jobs/media.ts'
import { runRenderJob } from './jobs/render.ts'

/**
 * Worker isolado da API. Pode haver várias réplicas; cada fila tem sua
 * concorrência. Jobs travados (worker morto) voltam à fila pelo mecanismo
 * de "stalled" do BullMQ após lockDuration e são retomados de forma
 * idempotente.
 */
const ctx = await createContext()
const connection = ctx.redis
const lockDuration = Number(process.env.WORKER_LOCK_MS ?? 60_000)
const attemptsOf = (job: Job) => job.opts.attempts ?? 1

const workers = [
  new Worker<MediaJob>(QUEUES.media, (job) => runMediaJob(ctx, job.data, job.attemptsMade, attemptsOf(job)), { connection, concurrency: Number(process.env.WORKER_CONCURRENCY_MEDIA ?? 2), lockDuration }),
  new Worker<RenderJobData>(QUEUES.render, (job) => runRenderJob(ctx, job.data.renderJobId, job.attemptsMade, attemptsOf(job)), { connection, concurrency: Number(process.env.WORKER_CONCURRENCY_RENDER ?? 1), lockDuration, stalledInterval: Math.min(30_000, lockDuration) }),
  new Worker<GenerationJobData>(QUEUES.generation, (job) => runGenerationJob(ctx, job.data, job.attemptsMade, attemptsOf(job)), { connection, concurrency: 4, lockDuration }),
  new Worker<MaintenanceJob>(QUEUES.maintenance, (job) => runMaintenance(ctx, job.data), { connection, concurrency: 1 }),
]
for (const w of workers) {
  w.on('failed', (job, err) => ctx.log('job.failed', { queue: w.name, id: job?.id, attempts: job?.attemptsMade, message: err.message.slice(0, 300) }))
  w.on('error', (err) => ctx.log('worker.error', { queue: w.name, message: err.message }))
}

await ctx.queues.maintenance.upsertJobScheduler('cleanup', { every: 15 * 60_000 }, { name: 'cleanup', data: { type: 'cleanup' } })
await ctx.queues.maintenance.upsertJobScheduler('gc', { every: 6 * 3600_000 }, { name: 'gc', data: { type: 'gc' } })
await ctx.queues.maintenance.upsertJobScheduler('reconcile', { every: 5 * 60_000 }, { name: 'reconcile', data: { type: 'reconcile' } })
// reconciliação imediata ao iniciar (retoma o que ficou pendente)
await ctx.queues.maintenance.add('reconcile-boot', { type: 'reconcile' }, { jobId: `reconcile-boot-${Date.now()}` })
ctx.log('worker.started', { queues: workers.map((w) => w.name), lockDuration })

const shutdown = async () => {
  ctx.log('worker.stopping')
  await Promise.all(workers.map((w) => w.close()))
  await ctx.queues.close()
  ctx.redis.disconnect()
  await ctx.db.$disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
