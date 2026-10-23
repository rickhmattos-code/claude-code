import { getPrisma } from '@orion/db'
import { createQueues, createStorage, redisConnection } from '@orion/server'
import { ConfigSchema, type Deps } from './core.ts'

export function createDeps(env: Record<string, string | undefined> = process.env): Deps {
  const redis = redisConnection(env.REDIS_URL)
  return {
    db: getPrisma(env.DATABASE_URL),
    storage: createStorage(env),
    queues: createQueues(redis),
    redis,
    config: ConfigSchema.parse(env),
    env,
  }
}
