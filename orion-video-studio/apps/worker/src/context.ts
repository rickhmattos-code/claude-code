import { mkdir } from 'node:fs/promises'
import { type PrismaClient, getPrisma } from '@orion/db'
import { type FontSet, bundledFonts } from '@orion/media'
import { type Queues, type Storage, createQueues, createStorage, fromRepoRoot, redisConnection } from '@orion/server'
import type IORedis from 'ioredis'

export interface WorkerContext {
  db: PrismaClient
  storage: Storage
  queues: Queues
  redis: IORedis
  env: Record<string, string | undefined>
  tmpDir: string
  fonts: FontSet
  log: (msg: string, extra?: Record<string, unknown>) => void
}

export async function createContext(env: Record<string, string | undefined> = process.env): Promise<WorkerContext> {
  const redis = redisConnection(env.REDIS_URL)
  const tmpDir = fromRepoRoot(env.WORKER_TMP_DIR ?? './.data/tmp')
  await mkdir(tmpDir, { recursive: true })
  return {
    db: getPrisma(env.DATABASE_URL),
    storage: createStorage(env),
    queues: createQueues(redis),
    redis,
    env,
    tmpDir,
    fonts: bundledFonts(env.FONTS_DIR),
    // logs estruturados sem dados sensíveis (sem prompts completos, sem chaves)
    log: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), pid: process.pid, msg, ...extra })),
  }
}
