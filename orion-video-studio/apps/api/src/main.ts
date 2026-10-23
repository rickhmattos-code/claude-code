import { buildApp } from './app.ts'
import { createDeps } from './deps.ts'

const deps = createDeps()
const app = await buildApp(deps, { logger: true })
await app.listen({ port: deps.config.API_PORT, host: '0.0.0.0' })

const shutdown = async () => {
  await app.close()
  await deps.queues.close()
  deps.redis.disconnect()
  await deps.db.$disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
