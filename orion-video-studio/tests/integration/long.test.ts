import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { FLICKS_PER_SECOND, addCaption, addClip, createDocument, makeMediaClip, secondsToFlicks } from '@orion/timeline'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Client, FIXTURES, download, resetDatabase, seedCatalog, startApi, startWorker, tmpDir } from './harness.ts'

/**
 * Exportações longas (5 e 15 minutos) pela API + worker reais.
 *   RUN_LONG=5  npx vitest run tests/integration/long.test.ts
 *   RUN_LONG=15 npx vitest run tests/integration/long.test.ts   (inclui 5 min)
 * Registra tempo total e pico de memória (worker + processos FFmpeg filhos).
 */
const RUN = Number(process.env.RUN_LONG ?? 0)
const S = secondsToFlicks
let api: Awaited<ReturnType<typeof startApi>>
let worker: ChildProcess
let c: Client
let ws = ''
let video = ''
let narration = ''
let musicAsset = ''
let musicDur = 0

function treeRssKb(pid: number): number {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=']).toString()
    const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
    const children = new Map<number, number[]>()
    for (const [p, pp] of rows) children.set(pp!, [...(children.get(pp!) ?? []), p!])
    let total = 0
    const walk = (x: number) => {
      const row = rows.find((r) => r[0] === x)
      if (row) total += row[2]!
      for (const ch of children.get(x) ?? []) walk(ch)
    }
    walk(pid)
    return total
  } catch {
    return 0
  }
}

describe.runIf(RUN >= 5)('exportações longas', () => {
  beforeAll(async () => {
    resetDatabase()
    seedCatalog()
    worker = startWorker({ RENDER_CHUNK_SECONDS: '30', RENDER_X264_PRESET: 'veryfast', RENDER_CRF: '23' })
    api = await startApi()
    c = new Client(api.base)
    await c.post('/api/auth/register', { email: 'longo@exemplo.com', name: 'Longo', password: 'senha-forte-123' })
    ws = (await c.get('/api/auth/me')).json.workspaces[0].id
    video = (await c.waitAsset(await c.upload(ws, join(FIXTURES, 'video_30fps_1080p_20s.mp4'), 'video/mp4'))).id
    narration = (await c.waitAsset(await c.upload(ws, join(FIXTURES, 'tone_narration_30s.wav'), 'audio/wav'))).id
    const m = (await c.get(`/api/workspaces/${ws}/music?sfx=false&q=Aurora`)).json[0]
    musicAsset = m.assetId
    musicDur = m.durationFlicks
  }, 300_000)
  afterAll(async () => {
    worker?.kill('SIGKILL')
    await api?.close()
  })

  async function longExport(minutes: number) {
    const total = minutes * 60
    let doc = createDocument({ aspect: '16:9' })
    const [main, , , voice, music] = doc.tracks
    for (let t = 0; t < total; t += 20) doc = addClip(doc, main!.id, makeMediaClip('video', video, S(t), S(Math.min(20, total - t)), `Bloco ${t / 20 + 1}`))
    for (let t = 5; t + 30 <= total; t += 40) doc = addClip(doc, voice!.id, makeMediaClip('audio', narration, S(t), S(30), `Narração ${t}`))
    for (let t = 0; t < total; ) {
      const d = Math.min(Math.floor(musicDur / FLICKS_PER_SECOND), total - t)
      doc = addClip(doc, music!.id, makeMediaClip('audio', musicAsset, S(t), S(d), 'Música'))
      t += d
    }
    for (let t = 1; t + 2 < total; t += 6) doc = addCaption(doc, { start: S(t), end: S(t + 2.5), text: `Legenda no segundo ${t}` })
    const p = await c.post(`/api/workspaces/${ws}/projects`, { name: `Longo ${minutes} min`, aspect: '16:9' })
    const save = await c.put(`/api/projects/${p.json.id}`, { baseVersion: 1, document: doc })
    expect(save.status).toBe(200)
    const t0 = Date.now()
    let peakKb = 0
    const r = await c.post(`/api/projects/${p.json.id}/renders`, { preset: { resolution: '720p', captions: 'burn', normalizeLoudness: true }, idempotencyKey: `long-${minutes}-${Date.now()}` })
    const done = await c.waitRender(r.json.id, 3 * 3600_000, () => {
      peakKb = Math.max(peakKb, treeRssKb(worker.pid!))
    })
    const seconds = (Date.now() - t0) / 1000
    expect(done.status).toBe('succeeded')
    expect(done.validation.ok).toBe(true)
    const f = join(tmpDir, `long-${minutes}.mp4`)
    await download(api.base, done.downloadUrl, f)
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())
    expect(Math.abs(dur - total)).toBeLessThan(0.05)
    const report = { minutes, renderSeconds: Math.round(seconds), realtimeFactor: Number((total / seconds).toFixed(2)), peakMemoryMb: Math.round(peakKb / 1024), outputMb: Math.round(done.validation.sizeBytes / 1024 / 1024), cpus: cpus().length, cpuModel: cpus()[0]?.model, ramGb: Math.round(totalmem() / 1024 ** 3) }
    console.log(`PERF ${JSON.stringify(report)}`)
    const { appendFileSync } = await import('node:fs')
    appendFileSync(join(tmpDir, '..', 'orion-perf-results.jsonl'), `${JSON.stringify({ ...report, at: new Date().toISOString() })}\n`)
  }

  test('projeto de 5 minutos', () => longExport(5), 3600_000)
  test.runIf(RUN >= 15)('projeto de 15 minutos', () => longExport(15), 3 * 3600_000)
})
