import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'

/**
 * Ambiente de integração real: Postgres (banco orion_test), Redis (db 1),
 * armazenamento local temporário, API em processo e worker em processo
 * filho (para podermos matá-lo e testar recuperação).
 */

export const ROOT = resolve(__dirname, '../..')
export const FIXTURES = join(ROOT, 'tests/fixtures/media')
const tmp = mkdtempSync(join(tmpdir(), 'orion-it-'))

export const TEST_ENV: Record<string, string> = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://orion:orion@localhost:5432/orion_test',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: join(tmp, 'storage'),
  STORAGE_PUBLIC_BASE: '/api',
  URL_SIGNING_SECRET: 'integration-test-secret-0123456789-abcdef',
  WORKER_TMP_DIR: join(tmp, 'work'),
  FONTS_DIR: join(ROOT, 'assets/fonts'),
  WEB_ORIGIN: 'http://localhost:3000',
  API_PUBLIC_URL: 'http://localhost:4000',
  PROVIDERS_MOCK: '1',
  // chave falsa: os testes verificam que ela nunca sai do servidor
  GEMINI_API_KEY: 'sk-orion-test-secret-should-never-leak',
  RENDER_X264_PRESET: 'ultrafast',
  RENDER_CRF: '30',
  RENDER_CHUNK_SECONDS: '10',
  WORKER_LOCK_MS: '8000',
  MAX_PROJECT_SECONDS: '1800',
  DEFAULT_GENERATION_BUDGET_CENTS: '2000',
  NODE_ENV: 'test',
}

export function resetDatabase() {
  const url = new URL(TEST_ENV.DATABASE_URL!)
  const db = url.pathname.slice(1)
  const admin = new URL(url)
  admin.pathname = '/postgres'
  execFileSync('psql', [admin.toString(), '-q', '-c', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, '-c', `CREATE DATABASE ${db}`], { stdio: 'pipe' })
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: join(ROOT, 'packages/db'), env: { ...process.env, ...TEST_ENV }, stdio: 'pipe' })
  execFileSync('redis-cli', ['-u', TEST_ENV.REDIS_URL!, 'flushdb'], { stdio: 'pipe' })
}

export function seedCatalog() {
  execFileSync('node', ['--import', 'tsx', 'src/seed.ts'], { cwd: join(ROOT, 'apps/worker'), env: { ...process.env, ...TEST_ENV }, stdio: 'pipe' })
}

export function startWorker(extra: Record<string, string> = {}): ChildProcess {
  const child = spawn('node', ['--import', 'tsx', 'src/main.ts'], { cwd: join(ROOT, 'apps/worker'), env: { ...process.env, ...TEST_ENV, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', () => undefined)
  child.stderr?.on('data', (d) => process.env.DEBUG_WORKER && process.stderr.write(d))
  return child
}

export async function startApi(): Promise<{ app: FastifyInstance; base: string; close: () => Promise<void> }> {
  Object.assign(process.env, TEST_ENV)
  const { buildApp } = await import('../../apps/api/src/app.ts')
  const { createDeps } = await import('../../apps/api/src/deps.ts')
  const deps = createDeps({ ...process.env, ...TEST_ENV })
  const app = await buildApp(deps)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    async close() {
      const step = async (name: string, fn: () => Promise<unknown>) => {
        const t0 = Date.now()
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`encerramento travou em: ${name}`)), 10_000)
        })
        try {
          await Promise.race([fn(), timeout])
        } finally {
          clearTimeout(timer)
          if (process.env.DEBUG_CLOSE) console.error(`close ${name}: ${Date.now() - t0}ms`)
        }
      }
      // testes: encerra também conexões ativas (produção usa apenas as ociosas)
      app.server.closeAllConnections()
      await step('app', () => app.close())
      await step('queues', () => deps.queues.close())
      deps.redis.disconnect()
    },
  }
}

/** Cliente HTTP com cookie de sessão. */
export class Client {
  cookie = ''
  constructor(private readonly base: string) {}
  async req<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T; text: string; headers: Headers }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), origin: 'http://localhost:3000' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]!
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  get<T = any>(p: string) {
    return this.req<T>('GET', p)
  }
  post<T = any>(p: string, b: unknown = {}) {
    return this.req<T>('POST', p, b)
  }
  put<T = any>(p: string, b: unknown) {
    return this.req<T>('PUT', p, b)
  }
  del<T = any>(p: string) {
    return this.req<T>('DELETE', p)
  }
  /** upload completo via URLs assinadas (simples ou multipart) */
  async upload(ws: string, file: string, mimeType: string): Promise<string> {
    const data = readFileSync(file)
    const name = file.split('/').pop()!
    const up = await this.post(`/api/workspaces/${ws}/uploads`, { fileName: name, mimeType, sizeBytes: data.length })
    if (up.status !== 200) throw new Error(`upload: ${up.status} ${up.text}`)
    const u = up.json
    if (u.mode === 'SINGLE') {
      const r = await fetch(`${this.base}${u.url}`, { method: 'PUT', headers: { 'content-type': mimeType }, body: data })
      const text = await r.text() // consome o corpo para liberar a conexão keep-alive
      if (!r.ok) throw new Error(`PUT ${r.status} ${text}`)
      const c = await this.post(`/api/uploads/${u.uploadId}/complete`, {})
      if (c.status !== 200) throw new Error(`complete ${c.status} ${c.text}`)
    } else {
      const parts: Array<{ partNumber: number; etag: string }> = []
      for (const p of u.parts) {
        const slice = data.subarray((p.partNumber - 1) * u.partSize, p.partNumber * u.partSize)
        const r = await fetch(`${this.base}${p.url}`, { method: 'PUT', body: slice })
        await r.text()
        if (!r.ok) throw new Error(`PUT part ${r.status}`)
        parts.push({ partNumber: p.partNumber, etag: r.headers.get('etag') ?? '' })
      }
      const c = await this.post(`/api/uploads/${u.uploadId}/complete`, { parts })
      if (c.status !== 200) throw new Error(`complete ${c.status} ${c.text}`)
    }
    return u.assetId
  }
  async waitAsset(id: string, timeoutMs = 120_000) {
    const t0 = Date.now()
    for (;;) {
      const a = await this.get(`/api/assets/${id}`)
      if (a.json?.status === 'READY' || a.json?.status === 'FAILED') return a.json
      if (Date.now() - t0 > timeoutMs) throw new Error(`asset ${id} não ficou pronto`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  async waitRender(id: string, timeoutMs = 600_000, onTick?: (r: any) => void | Promise<void>) {
    const t0 = Date.now()
    for (;;) {
      const r = await this.get(`/api/renders/${id}`)
      await onTick?.(r.json)
      if (['succeeded', 'failed', 'canceled'].includes(r.json?.status)) return r.json
      if (Date.now() - t0 > timeoutMs) throw new Error(`render ${id} não terminou`)
      await new Promise((res) => setTimeout(res, 1000))
    }
  }
  async waitGeneration(id: string, timeoutMs = 120_000) {
    const t0 = Date.now()
    for (;;) {
      const r = await this.get(`/api/generations/${id}`)
      if (['succeeded', 'failed', 'canceled'].includes(r.json?.status)) return r.json
      if (Date.now() - t0 > timeoutMs) throw new Error(`geração ${id} não terminou`)
      await new Promise((res) => setTimeout(res, 500))
    }
  }
}

export async function download(base: string, url: string, dst: string) {
  const r = await fetch(`${base}${url}`)
  if (!r.ok) throw new Error(`download ${r.status}`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(dst, Buffer.from(await r.arrayBuffer()))
}

export const tmpDir = tmp
