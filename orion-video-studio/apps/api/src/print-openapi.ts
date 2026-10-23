import { buildApp } from './app.ts'
import { buildOpenApi } from './core.ts'
import { createDeps } from './deps.ts'

// registra as rotas para preencher o registro e imprime o documento
const deps = createDeps()
const app = await buildApp(deps)
await app.ready()
process.stdout.write(`${JSON.stringify(buildOpenApi(), null, 2)}\n`)
await app.close()
await deps.queues.close()
deps.redis.disconnect()
await deps.db.$disconnect()
