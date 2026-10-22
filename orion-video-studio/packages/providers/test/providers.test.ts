import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ProviderError,
  anthropicAdapter,
  applyPronunciation,
  elevenLabsAdapter,
  llmPlan,
  localPlan,
  openAiTranscriptionAdapter,
  providerStatuses,
  veoAdapter,
} from '../src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'orion-prov-'))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('provider status', () => {
  test('without credentials every external provider is pending and mocks are hidden', () => {
    const s = providerStatuses({})
    const external = s.filter((p) => ['google-veo', 'elevenlabs', 'openai-image', 'openai-transcription', 'anthropic'].includes(p.id))
    expect(external).toHaveLength(5)
    for (const p of external) {
      expect(p.configured).toBe(false)
      expect(p.mode).toBe('pending-config')
      expect(p.missingEnv.length).toBeGreaterThan(0)
    }
    expect(s.some((p) => p.mode === 'mock')).toBe(false)
    expect(s.find((p) => p.id === 'music-generation')!.configured).toBe(false)
  })
  test('mock providers are labelled as mock', () => {
    const s = providerStatuses({ PROVIDERS_MOCK: '1' })
    expect(s.filter((p) => p.mode === 'mock').length).toBe(4)
  })
})

describe('Veo adapter contract (mocked HTTP)', () => {
  test('start → poll → download use the documented REST shape', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith(':predictLongRunning')) return json({ name: 'models/veo-3.1-generate-preview/operations/abc123' })
      if (url.includes('/operations/abc123')) return json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/x:download?alt=media' } }] } } })
      return new Response('VIDEO', { status: 200 })
    })
    const env = { GEMINI_API_KEY: 'segredo-123' }
    const { remoteId } = await veoAdapter.start({ model: 'veo-3.1-generate-preview', mode: 'text-to-video', prompt: 'um farol', durationSeconds: 8, aspect: '9:16', resolution: '720p' }, env)
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning')
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.instances[0].prompt).toBe('um farol')
    expect(body.parameters).toMatchObject({ aspectRatio: '9:16', durationSeconds: 8 })
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('segredo-123')
    const poll = await veoAdapter.poll(remoteId, env)
    expect(poll.state).toBe('succeeded')
    const dst = join(dir, 'veo.mp4')
    await veoAdapter.download(poll.result, dst, env)
    expect(readFileSync(dst, 'utf8')).toBe('VIDEO')
  })
  test('rejects unsupported durations before calling the provider', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(veoAdapter.start({ model: 'veo-3.1-generate-preview', mode: 'text-to-video', prompt: 'x', durationSeconds: 30, aspect: '16:9', resolution: '720p' }, { GEMINI_API_KEY: 'k' })).rejects.toThrow(/aceita durações/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  test('quota errors are classified and never leak the key', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'quota' }, 429))
    const err = await veoAdapter.start({ model: 'veo-3.1-generate-preview', mode: 'text-to-video', prompt: 'x', durationSeconds: 8, aspect: '16:9', resolution: '720p' }, { GEMINI_API_KEY: 'segredo-xyz' }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.kind).toBe('quota')
    expect(String(err.message)).not.toContain('segredo-xyz')
  })
  test('download refuses unexpected hosts', async () => {
    await expect(veoAdapter.download({ uri: 'https://evil.example/x' }, join(dir, 'x'), { GEMINI_API_KEY: 'k' })).rejects.toThrow(/bloqueada/)
  })
})

describe('ElevenLabs adapter contract (mocked HTTP)', () => {
  test('returns real alignment from the provider', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) }
      return json({ audio_base64: Buffer.from('MP3').toString('base64'), alignment: { characters: ['O', 'i'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] } })
    })
    const r = await elevenLabsAdapter.synthesize({ model: 'eleven_multilingual_v2', voiceId: 'voz123', text: 'Oi', speed: 1.1 }, join(dir, 'a.mp3'), { ELEVENLABS_API_KEY: 'k' })
    expect(seen!.url).toContain('/v1/text-to-speech/voz123/with-timestamps')
    expect(seen!.body.voice_settings).toMatchObject({ speed: 1.1 })
    expect(r.alignment!.ends).toEqual([0.1, 0.2])
  })
})

describe('OpenAI transcription contract (mocked HTTP)', () => {
  test('maps verbose_json words and segments', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const form = init.body as FormData
      expect(form.get('response_format')).toBe('verbose_json')
      expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment'])
      return json({ text: 'olá mundo', segments: [{ start: 0, end: 1, text: ' olá mundo' }], words: [{ word: 'olá', start: 0, end: 0.4 }, { word: 'mundo', start: 0.5, end: 1 }] })
    })
    const file = join(dir, 'a.wav')
    require('node:fs').writeFileSync(file, 'x')
    const r = await openAiTranscriptionAdapter.transcribe({ model: 'whisper-1', path: file, language: 'pt-BR' }, { OPENAI_API_KEY: 'k' })
    expect(r.words).toHaveLength(2)
    expect(r.segments[0]!.text).toBe('olá mundo')
  })
})

describe('assistant', () => {
  const brief = { theme: 'Disciplina diária', audience: 'empreendedores', goal: 'Seguir o perfil', durationSeconds: 90, aspect: '9:16' as const, tone: 'reflexivo', visualStyle: 'Fotografia escura e quente' }
  test('local plan is structural, labelled and never pretends to be AI', () => {
    const p = localPlan(brief, 8)
    expect(p.source).toBe('local')
    expect(p.openings).toHaveLength(3)
    expect(p.script).toContain('[edite]')
    expect(p.notes.join(' ')).toMatch(/sem IA/)
    expect(p.musicSuggestions[0]!.mood).toBe('contemplativo')
  })
  test('LLM plan output is schema-validated', async () => {
    vi.stubGlobal('fetch', async () =>
      json({ content: [{ type: 'text', text: '```json\n{"openings":["a","b","c"],"script":"Parágrafo um tem frases.\\n\\nParágrafo dois também.","cta":"Siga"}\n```' }] }),
    )
    const p = await llmPlan(anthropicAdapter, { ANTHROPIC_API_KEY: 'k' }, brief, 8)
    expect(p.source).toBe('llm')
    expect(p.scenes).toHaveLength(2)
  })
  test('invalid LLM output is rejected', async () => {
    vi.stubGlobal('fetch', async () => json({ content: [{ type: 'text', text: '{"openings":["só uma"]}' }] }))
    await expect(llmPlan(anthropicAdapter, { ANTHROPIC_API_KEY: 'k' }, brief, 8)).rejects.toThrow()
  })
})

test('pronunciation dictionary substitutes whole words only', () => {
  expect(applyPronunciation('ORION e ORIONTE', { ORION: 'Órion' })).toBe('Órion e ORIONTE')
})
