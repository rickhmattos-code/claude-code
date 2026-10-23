import type { ChildProcess } from 'node:child_process'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { TimelineDoc } from '@orion/shared'
import { FLICKS_PER_SECOND, addCaption, addClip, createDocument, makeMediaClip, makeTextClip, secondsToFlicks } from '@orion/timeline'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Client, FIXTURES, ROOT, TEST_ENV, download, resetDatabase, seedCatalog, startApi, startWorker, tmpDir } from './harness.ts'

const S = secondsToFlicks
let api: Awaited<ReturnType<typeof startApi>>
let worker: ChildProcess
let A: Client
let B: Client
let wsA = ''
let wsB = ''
const assets: Record<string, any> = {}

function probe(file: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString())
}

/** Energia (dB RMS) acima de 1 kHz num intervalo — mede a música sem o tom de narração (220 Hz). */
function hfLevel(file: string, from: number, to: number): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-af', 'highpass=f=1000,highpass=f=1000,astats', '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/.exec(r.stderr)
  return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : Number.NaN
}

beforeAll(async () => {
  resetDatabase()
  seedCatalog()
  worker = startWorker()
  api = await startApi()
  A = new Client(api.base)
  B = new Client(api.base)
  expect((await A.post('/api/auth/register', { email: 'ana@exemplo.com', name: 'Ana', password: 'senha-forte-123' })).status).toBe(200)
  expect((await B.post('/api/auth/register', { email: 'bruno@exemplo.com', name: 'Bruno', password: 'senha-forte-456' })).status).toBe(200)
  wsA = (await A.get('/api/auth/me')).json.workspaces[0].id
  wsB = (await B.get('/api/auth/me')).json.workspaces[0].id
}, 180_000)

afterAll(async () => {
  worker?.kill('SIGKILL')
  await api?.close()
})

describe('autenticação e limites', () => {
  test('senha errada → 401; sessão inválida → 401', async () => {
    const c = new Client(api.base)
    expect((await c.post('/api/auth/login', { email: 'ana@exemplo.com', password: 'errada-errada' })).status).toBe(401)
    expect((await c.get(`/api/workspaces/${wsA}/projects`)).status).toBe(401)
  })
  test('origem estranha é bloqueada (CSRF)', async () => {
    const r = await fetch(`${api.base}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: A.cookie }, body: JSON.stringify({ name: 'x', aspect: '9:16' }) })
    expect(r.status).toBe(403)
  })
  test('rate limit no login', async () => {
    const c = new Client(api.base)
    let last = 0
    for (let i = 0; i < 12; i++) last = (await c.post('/api/auth/login', { email: 'x@y.com', password: 'zzzzzzzzzz' })).status
    expect(last).toBe(429)
  })
})

describe('upload e processamento de mídia', () => {
  test('upload simples: vídeo, áudio e imagem ficam prontos com inspeção ffprobe', async () => {
    assets.video = await A.waitAsset(await A.upload(wsA, join(FIXTURES, 'video_30fps_1080p_20s.mp4'), 'video/mp4'))
    assets.rotated = await A.waitAsset(await A.upload(wsA, join(FIXTURES, 'video_25fps_rotated_12s.mp4'), 'video/mp4'))
    assets.narration = await A.waitAsset(await A.upload(wsA, join(FIXTURES, 'tone_narration_30s.wav'), 'audio/wav'))
    assets.image = await A.waitAsset(await A.upload(wsA, join(FIXTURES, 'image_portrait.png'), 'image/png'))
    expect(assets.video.status).toBe('READY')
    expect(assets.video.durationFlicks).toBe(20 * FLICKS_PER_SECOND)
    expect(assets.video.thumbnailUrl).toBeTruthy()
    expect(assets.video.proxyUrl).toBeTruthy()
    expect(assets.video.proxyWebmUrl).toBeTruthy()
    expect(assets.rotated.rotation).toBe(90)
    expect(assets.rotated.height).toBeGreaterThan(assets.rotated.width)
    expect(assets.narration.waveformUrl).toBeTruthy()
    expect(assets.image.kind).toBe('IMAGE')
  }, 180_000)

  test('upload multipart (> 32 MB) é montado e validado', async () => {
    const big = join(tmpDir, 'grande.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '18', '-pix_fmt', 'yuv420p', big])
    const size = require('node:fs').statSync(big).size
    expect(size).toBeGreaterThan(32 * 1024 * 1024)
    const a = await A.waitAsset(await A.upload(wsA, big, 'video/mp4'), 240_000)
    expect(a.status).toBe('READY')
    expect(a.sizeBytes).toBe(size)
  }, 300_000)

  test('conteúdo que não corresponde ao tipo declarado é recusado', async () => {
    const fake = join(tmpDir, 'falso.mp4')
    require('node:fs').writeFileSync(fake, 'isto não é um vídeo '.repeat(100))
    const a = await A.waitAsset(await A.upload(wsA, fake, 'video/mp4'))
    expect(a.status).toBe('FAILED')
  }, 60_000)

  test('tamanho diferente do declarado é rejeitado na conclusão', async () => {
    const up = await A.post(`/api/workspaces/${wsA}/uploads`, { fileName: 'x.png', mimeType: 'image/png', sizeBytes: 1000 })
    await fetch(`${api.base}${up.json.url}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.alloc(10) })
    const c = await A.post(`/api/uploads/${up.json.uploadId}/complete`, {})
    expect(c.status).toBe(400)
  })
})

function buildDoc(): TimelineDoc {
  let doc = createDocument({ aspect: '9:16' })
  const [main, overlay, text, voice, music] = doc.tracks
  doc = addClip(doc, main!.id, makeMediaClip('video', assets.video.id, 0, S(20), 'Vídeo'))
  const r = makeMediaClip('video', assets.rotated.id, S(20), S(12), 'Rotacionado')
  r.transitionIn = { type: 'dissolve', duration: S(0.5) }
  doc = addClip(doc, main!.id, r)
  doc = addClip(doc, main!.id, makeMediaClip('image', assets.image.id, S(32), S(63), 'Imagem'))
  doc = addClip(doc, text!.id, makeTextClip('Mais de 60 segundos', S(1), S(4)))
  doc = addClip(doc, voice!.id, makeMediaClip('audio', assets.narration.id, S(3), S(30), 'Narração'))
  doc = addCaption(doc, { start: S(3), end: S(6), text: 'Legenda de teste' })
  void overlay
  void music
  return doc
}

describe('projetos, isolamento e concorrência', () => {
  let projectId = ''
  let version = 1
  test('salvar e reabrir preserva o documento', async () => {
    const p = await A.post(`/api/workspaces/${wsA}/projects`, { name: 'Projeto A', aspect: '9:16' })
    projectId = p.json.id
    const doc = buildDoc()
    const s = await A.put(`/api/projects/${projectId}`, { baseVersion: 1, document: doc })
    expect(s.status).toBe(200)
    version = s.json.docVersion
    const g = await A.get(`/api/projects/${projectId}`)
    expect(g.json.docVersion).toBe(version)
    expect(g.json.document.tracks[0].clips).toHaveLength(3)
    expect(g.json.document.captions.segments[0].text).toBe('Legenda de teste')
  })
  test('versão desatualizada → 409 (sem sobrescrever)', async () => {
    const stale = await A.put(`/api/projects/${projectId}`, { baseVersion: version - 1, document: buildDoc() })
    expect(stale.status).toBe(409)
  })
  test('outro usuário não lê, não altera e não exporta projeto alheio', async () => {
    expect((await B.get(`/api/projects/${projectId}`)).status).toBe(404)
    expect((await B.put(`/api/projects/${projectId}`, { baseVersion: version, document: buildDoc() })).status).toBe(404)
    expect((await B.post(`/api/projects/${projectId}/renders`, { preset: { resolution: '720p', captions: 'none', normalizeLoudness: true }, idempotencyKey: 'bbbbbbbbbbbb' })).status).toBe(404)
    expect((await B.get(`/api/workspaces/${wsA}/projects`)).status).toBe(404)
    expect((await B.get(`/api/assets/${assets.video.id}`)).status).toBe(404)
    expect((await B.del(`/api/assets/${assets.video.id}`)).status).toBe(404)
    expect((await B.get(`/api/projects/${projectId}/captions.srt`)).status).toBe(404)
  })
  test('outro usuário não consegue referenciar mídia alheia no próprio projeto', async () => {
    const p = await B.post(`/api/workspaces/${wsB}/projects`, { name: 'Projeto B', aspect: '9:16' })
    const r = await B.put(`/api/projects/${p.json.id}`, { baseVersion: 1, document: buildDoc() })
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBe('foreign_assets')
  })
  test('mídia em uso não pode ser excluída', async () => {
    const r = await A.del(`/api/assets/${assets.video.id}`)
    expect(r.status).toBe(409)
  })
  test('legendas exportadas em SRT e VTT', async () => {
    const srt = await A.get(`/api/projects/${projectId}/captions.srt`)
    expect(srt.text).toContain('00:00:03,000 --> 00:00:06,000')
    const vtt = await A.get(`/api/projects/${projectId}/captions.vtt`)
    expect(vtt.text.startsWith('WEBVTT')).toBe(true)
  })
  test('histórico de versões e restauração', async () => {
    const rv = await A.post(`/api/projects/${projectId}/revisions`, { reason: 'Antes do corte' })
    expect(rv.status).toBe(200)
    const list = await A.get(`/api/projects/${projectId}/revisions`)
    expect(list.json.length).toBeGreaterThanOrEqual(2)
    const restore = await A.post(`/api/projects/${projectId}/revisions/${list.json.at(-1).id}/restore`, {})
    expect(restore.status).toBe(200)
    expect(restore.json.document.tracks[0].clips).toHaveLength(0)
    const back = await A.post(`/api/projects/${projectId}/revisions/${rv.json.id}/restore`, {})
    expect(back.json.document.tracks[0].clips).toHaveLength(3)
  })

  test('corte curto: cria novo projeto com o trecho, exige versão atual e respeita o isolamento', async () => {
    const cur = await A.get(`/api/projects/${projectId}`)
    const body = { name: 'Corte 1', baseVersion: cur.json.docVersion, start: S(2), end: S(8), aspect: '1:1' }
    expect((await A.post(`/api/projects/${projectId}/derive`, { ...body, baseVersion: cur.json.docVersion - 1 })).status).toBe(409)
    expect((await B.post(`/api/projects/${projectId}/derive`, body)).status).toBe(404)
    const r = await A.post(`/api/projects/${projectId}/derive`, body)
    expect(r.status).toBe(200)
    expect(r.json.durationFlicks).toBe(S(6))
    const np = await A.get(`/api/projects/${r.json.id}`)
    expect(np.json.document.settings).toMatchObject({ aspect: '1:1', width: 1080, height: 1080 })
    expect(np.json.document.tracks[0].clips[0].start).toBe(0)
    // projeto de origem intacto
    expect((await A.get(`/api/projects/${projectId}`)).json.docVersion).toBe(cur.json.docVersion)
  })

  test('tradução de legendas: simulador marcado, tempos preservados, isolamento', async () => {
    const segments = [{ id: 's1', start: S(3), end: S(6), text: 'Legenda de teste' }]
    expect((await B.post(`/api/projects/${projectId}/captions/translate`, { target: 'en', segments })).status).toBe(404)
    const r = await A.post(`/api/projects/${projectId}/captions/translate`, { target: 'en', segments })
    expect(r.status).toBe(200)
    expect(r.json.mode).toBe('mock')
    expect(r.json.segments).toEqual([{ id: 's1', start: S(3), end: S(6), text: '[TESTE→en] Legenda de teste' }])
    expect((await A.get('/api/providers')).json.translation).toMatchObject({ configured: true, mode: 'mock' })
  })

  test('exporta vídeo real > 60 s; editar durante a exportação não altera o resultado', async () => {
    const cur = await A.get(`/api/projects/${projectId}`)
    const key = `render-${Date.now()}`
    const r = await A.post(`/api/projects/${projectId}/renders`, { preset: { resolution: '720p', captions: 'both', normalizeLoudness: true }, idempotencyKey: key })
    expect(r.status).toBe(200)
    // edição concorrente: remove todos os clipes do projeto enquanto renderiza
    const empty = { ...cur.json.document, tracks: cur.json.document.tracks.map((t: any) => ({ ...t, clips: [] })) }
    expect((await A.put(`/api/projects/${projectId}`, { baseVersion: cur.json.docVersion, document: empty })).status).toBe(200)
    // idempotência: mesma chave devolve o mesmo job
    const dup = await A.post(`/api/projects/${projectId}/renders`, { preset: { resolution: '720p', captions: 'both', normalizeLoudness: true }, idempotencyKey: key })
    expect(dup.json.id).toBe(r.json.id)
    const done = await A.waitRender(r.json.id)
    expect(done.status).toBe('succeeded')
    expect(done.validation.ok).toBe(true)
    const file = join(tmpDir, 'export95.mp4')
    await download(api.base, done.downloadUrl, file)
    const info = probe(file)
    expect(Number(info.format.duration)).toBeGreaterThan(94.9)
    expect(Number(info.format.duration)).toBeLessThan(95.2)
    expect(info.streams.map((s: any) => s.codec_name).sort()).toEqual(['aac', 'h264'])
    expect(done.srtUrl).toBeTruthy()
    // B não acessa a exportação de A
    expect((await B.get(`/api/renders/${r.json.id}`)).status).toBe(404)
    // restaura o documento para os próximos testes
    const now = await A.get(`/api/projects/${projectId}`)
    await A.put(`/api/projects/${projectId}`, { baseVersion: now.json.docVersion, document: cur.json.document })
  }, 600_000)
})

describe('mixagem: música + narração com ducking', () => {
  test('a música fica mais baixa durante a fala quando o ducking está ativo', async () => {
    const music = (await A.get(`/api/workspaces/${wsA}/music?sfx=false&q=Aurora`)).json[0]
    expect(music.license.licenseName).toBe('CC0-1.0')
    const render = async (duck: boolean) => {
      let doc = createDocument({ aspect: '16:9' })
      const voice = doc.tracks.find((t) => t.kind === 'voice')!
      const mus = doc.tracks.find((t) => t.kind === 'music')!
      doc = addClip(doc, mus.id, makeMediaClip('audio', music.assetId, 0, S(20), 'Música'))
      doc = addClip(doc, voice.id, makeMediaClip('audio', assets.narration.id, S(8), S(8), 'Fala'))
      doc = { ...doc, tracks: doc.tracks.map((t) => (t.id === mus.id ? { ...t, duckUnderVoice: duck, volume: 1 } : t)) }
      const p = await A.post(`/api/workspaces/${wsA}/projects`, { name: `Ducking ${duck}`, aspect: '16:9' })
      await A.put(`/api/projects/${p.json.id}`, { baseVersion: 1, document: doc })
      const r = await A.post(`/api/projects/${p.json.id}/renders`, { preset: { resolution: '720p', captions: 'none', normalizeLoudness: false }, idempotencyKey: `duck-${duck}-${Date.now()}` })
      const done = await A.waitRender(r.json.id)
      expect(done.status).toBe('succeeded')
      const f = join(tmpDir, `duck-${duck}.mp4`)
      await download(api.base, done.downloadUrl, f)
      return f
    }
    const on = await render(true)
    const off = await render(false)
    const onSpeech = hfLevel(on, 9, 15)
    const offSpeech = hfLevel(off, 9, 15)
    const onBefore = hfLevel(on, 2, 7)
    const offBefore = hfLevel(off, 2, 7)
    // fora da fala: praticamente igual; durante a fala: pelo menos 3 dB a menos
    expect(Math.abs(onBefore - offBefore)).toBeLessThan(1)
    expect(offSpeech - onSpeech).toBeGreaterThan(3)
  }, 600_000)
})

describe('gerações por IA (provedores simulados) e custos', () => {
  test('integração sem credencial retorna configuração pendente (nunca sucesso fictício)', async () => {
    const req = { kind: 'TTS', provider: 'elevenlabs', model: 'eleven_multilingual_v2', voiceId: 'abc', text: 'Olá', speed: 1 }
    const est = await A.post(`/api/workspaces/${wsA}/generations/estimate`, { request: req })
    expect(est.json.configured).toBe(false)
    const r = await A.post(`/api/workspaces/${wsA}/generations`, { request: req, idempotencyKey: 'pending-config-1', acceptEstimatedCents: null })
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('provider_not_configured')
  })
  test('sem preço confiável configurado a geração é bloqueada', async () => {
    const req = { kind: 'VIDEO', provider: 'google-veo', model: 'veo-3.1-generate-preview', mode: 'text-to-video', prompt: 'farol', durationSeconds: 8, aspect: '9:16', resolution: '720p' }
    const est = await A.post(`/api/workspaces/${wsA}/generations/estimate`, { request: req })
    expect(est.json.configured).toBe(true)
    expect(est.json.estimatedCents).toBeNull()
    const r = await A.post(`/api/workspaces/${wsA}/generations`, { request: req, idempotencyKey: 'no-price-1', acceptEstimatedCents: null })
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('pricing_missing')
  })
  test('duração não suportada pelo provedor é recusada antes de qualquer chamada', async () => {
    const r = await A.post(`/api/workspaces/${wsA}/generations/estimate`, { request: { kind: 'VIDEO', provider: 'mock-video', model: 'mock-video-1', mode: 'text-to-video', prompt: 'x', durationSeconds: 30, aspect: '9:16', resolution: '720p' } })
    expect(r.status).toBe(400)
  })
  test('estimativa precisa ser aceita; voz gerada; frase regenerada isoladamente; aprovado é reutilizado', async () => {
    const req = { kind: 'TTS', provider: 'mock-tts', model: 'mock-tts-1', voiceId: 'mock-voz-a', text: 'Primeira frase da narração.', speed: 1, sentenceKey: 'frase-1' }
    const wrong = await A.post(`/api/workspaces/${wsA}/generations`, { request: req, idempotencyKey: 'tts-wrong-1', acceptEstimatedCents: 5 })
    expect(wrong.status).toBe(409)
    const g = await A.post(`/api/workspaces/${wsA}/generations`, { request: req, idempotencyKey: 'tts-ok-1', acceptEstimatedCents: 0 })
    expect(g.status).toBe(200)
    const done = await A.waitGeneration(g.json.id)
    expect(done.status).toBe('succeeded')
    expect(done.result.timing).toBe('sentence') // provedor simulado não inventa tempo por palavra
    expect(done.result.captions[0].words).toBeUndefined()
    const asset = await A.waitAsset(done.resultAssetId)
    expect(asset.kind).toBe('AUDIO')
    // idempotência
    const again = await A.post(`/api/workspaces/${wsA}/generations`, { request: req, idempotencyKey: 'tts-ok-1', acceptEstimatedCents: 0 })
    expect(again.json.id).toBe(g.json.id)
    // regenerar só a frase (novo texto, mesma chave de frase) → novo job; versão anterior preservada
    const regen = await A.post(`/api/workspaces/${wsA}/generations`, { request: { ...req, text: 'Primeira frase, agora reescrita.' }, idempotencyKey: 'tts-regen-1', acceptEstimatedCents: 0 })
    const regenDone = await A.waitGeneration(regen.json.id)
    expect(regenDone.resultAssetId).not.toBe(done.resultAssetId)
    const versions = (await A.get(`/api/workspaces/${wsA}/generations?kind=TTS`)).json.filter((x: any) => x.input.sentenceKey === 'frase-1')
    expect(versions).toHaveLength(2)
    // aprovar e reutilizar
    await A.post(`/api/generations/${g.json.id}/approve`, { approved: true })
    const reuse = await A.post(`/api/workspaces/${wsA}/generations`, { request: req, idempotencyKey: 'tts-reuse-1', acceptEstimatedCents: 0 })
    expect(reuse.json.reused).toBe(true)
    expect(reuse.json.id).toBe(g.json.id)
    // custo: estimado → confirmado no ledger
    const usage = await A.get(`/api/workspaces/${wsA}/usage`)
    expect(usage.json.entries.some((e: any) => e.status === 'CONFIRMED')).toBe(true)
  }, 120_000)
  test('cena por vídeo: operação longa com ID remoto, consulta de status e download', async () => {
    const p = await A.post(`/api/workspaces/${wsA}/projects`, { name: 'Cenas', aspect: '9:16' })
    const g = await A.post(`/api/workspaces/${wsA}/generations`, {
      request: { kind: 'VIDEO', provider: 'mock-video', model: 'mock-video-1', mode: 'text-to-video', prompt: 'um farol na tempestade', durationSeconds: 4, aspect: '9:16', resolution: '720p', sceneKey: 'cena-001' },
      idempotencyKey: 'video-scene-1',
      acceptEstimatedCents: 0,
      projectId: p.json.id,
    })
    const done = await A.waitGeneration(g.json.id)
    expect(done.status).toBe('succeeded')
    expect(done.sceneKey).toBe('cena-001')
    const a = await A.waitAsset(done.resultAssetId)
    expect(a.durationFlicks).toBe(4 * FLICKS_PER_SECOND)
  }, 120_000)
  test('nenhuma resposta pública contém a chave do servidor', async () => {
    const secret = TEST_ENV.GEMINI_API_KEY!
    const bodies = [
      (await A.get('/api/providers')).text,
      (await A.post(`/api/workspaces/${wsA}/generations/estimate`, { request: { kind: 'VIDEO', provider: 'google-veo', model: 'veo-3.1-generate-preview', mode: 'text-to-video', prompt: 'x', durationSeconds: 8, aspect: '9:16', resolution: '720p' } })).text,
      (await A.get(`/api/workspaces/${wsA}/generations`)).text,
      (await A.get('/api/openapi.json')).text,
    ]
    for (const b of bodies) expect(b).not.toContain(secret)
  })
})

describe('recuperação de falha do worker', () => {
  test('matar o worker no meio da exportação: novo worker retoma e reaproveita blocos prontos', async () => {
    let doc = createDocument({ aspect: '16:9' })
    const main = doc.tracks[0]!
    for (let i = 0; i < 4; i++) doc = addClip(doc, main.id, makeMediaClip('video', assets.video.id, S(i * 20), S(20), `Parte ${i + 1}`))
    const p = await A.post(`/api/workspaces/${wsA}/projects`, { name: 'Recuperação', aspect: '16:9' })
    await A.put(`/api/projects/${p.json.id}`, { baseVersion: 1, document: doc })
    const r = await A.post(`/api/projects/${p.json.id}/renders`, { preset: { resolution: '1080p', captions: 'none', normalizeLoudness: false }, idempotencyKey: `recover-${Date.now()}` })
    let killed = false
    const done = await A.waitRender(r.json.id, 900_000, async (st) => {
      if (!killed && st?.status === 'running' && st.progress > 0.35) {
        worker.kill('SIGKILL')
        killed = true
        await new Promise((res) => setTimeout(res, 1000))
        worker = startWorker()
      }
    })
    expect(killed).toBe(true)
    expect(done.status).toBe('succeeded')
    expect(done.attempts).toBeGreaterThanOrEqual(2)
    expect(done.validation.reusedIntermediates).toBeGreaterThan(0)
    expect(done.validation.ok).toBe(true)
  }, 900_000)
})

test('raiz do projeto resolvida', () => expect(ROOT).toContain('orion-video-studio'))
