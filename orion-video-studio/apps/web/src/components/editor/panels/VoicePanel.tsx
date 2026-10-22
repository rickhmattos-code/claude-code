'use client'
import type { CaptionSegment, GenerationRequest } from '@orion/shared'
import { addClip, clipEnd, estimateNarrationSeconds, findClip, findFreeSlot, formatClock, makeMediaClip, newId, quantize, replaceSentenceAudio, splitSentences } from '@orion/timeline'
import { Badge, Button, Field, Select, Slider, TextArea, useToast } from '@orion/ui'
import { produce } from 'immer'
import { History, RefreshCw, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { AssetDto, GenerationDto, ProvidersDto } from '@/lib/types'
import { useDoc, useEditor } from '../store'
import { useGeneration } from '../useGeneration'

interface Voice {
  id: string
  name: string
  language: string | null
}

export function VoicePanel() {
  const doc = useDoc()
  const { workspaceId, projectId, apply, playhead, selection, upsertAsset } = useEditor()
  const toast = useToast()
  const { run, dialog, busy } = useGeneration(workspaceId, projectId)
  const [providers, setProviders] = useState<ProvidersDto | null>(null)
  const [provider, setProvider] = useState('')
  const [voices, setVoices] = useState<Voice[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [speed, setSpeed] = useState(1)
  const [script, setScript] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  useEffect(() => {
    api<ProvidersDto>('/providers')
      .then((p) => {
        setProviders(p)
        const first = p.tts.find((x) => x.configured)
        if (first) setProvider(first.id)
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!provider) return
    api<{ voices: Voice[] }>(`/voices/catalog?provider=${provider}`)
      .then((r) => {
        setVoices(r.voices)
        setVoiceId((v) => v || r.voices[0]?.id || '')
      })
      .catch((e) => toast(errorMessage(e), 'danger'))
  }, [provider, toast])
  const adapter = providers?.tts.find((p) => p.id === provider)
  const model = adapter?.models[0]
  const sentences = splitSentences(script, 400)

  async function fetchAsset(id: string): Promise<AssetDto> {
    const [a] = await api<AssetDto[]>('/assets/batch', { body: { ids: [id] } })
    if (!a) throw new Error('Áudio gerado não encontrado')
    upsertAsset(a)
    return a
  }

  async function generateAll() {
    if (!adapter || !model || !voiceId || !sentences.length) return
    const reqs: GenerationRequest[] = sentences.map((text) => ({ kind: 'TTS', provider: adapter.id, model: model.id, voiceId, text, speed, sentenceKey: newId().slice(0, 12) }))
    setProgress(`0/${reqs.length}`)
    let done = 0
    const results = await run(reqs, `Gerar narração de ${reqs.length} frase(s) com ${adapter.label}${adapter.mode === 'mock' ? ' (MODO DE TESTE)' : ''}.`, (_, g) => {
      if (g.status === 'succeeded' || g.status === 'failed') setProgress(`${++done}/${reqs.length}`)
    })
    setProgress(null)
    const voice = doc.tracks.find((t) => t.kind === 'voice' && !t.locked)
    if (!voice) return toast('Adicione uma trilha de narração desbloqueada.', 'danger')
    let cursor = quantize(playhead, doc.settings.fps)
    const ok = results.filter((g): g is GenerationDto => !!g && g.status === 'succeeded' && !!g.resultAssetId)
    const failed = results.filter((g) => g && g.status !== 'succeeded')
    if (failed.length) toast(`${failed.length} frase(s) falharam: ${failed[0]?.error ?? ''}`, 'danger')
    for (const [i, g] of ok.entries()) await fetchAsset(g.resultAssetId!)
    apply((d) => {
      let out = d
      for (const [i, g] of ok.entries()) {
        const res = g.result as { durationFlicks: number; captions: CaptionSegment[] }
        const dur = quantize(res.durationFlicks, d.settings.fps, 'floor')
        const track = out.tracks.find((t) => t.id === voice.id)!
        const at = findFreeSlot(track, cursor, dur)
        const clip = makeMediaClip('audio', g.resultAssetId!, at, dur, sentences[i] ?? `Frase ${i + 1}`)
        clip.sceneKey = (g.input.sentenceKey as string) ?? undefined
        out = addClip(out, voice.id, clip)
        out = produce(out, (x) => {
          for (const c of res.captions) x.captions.segments.push({ ...c, id: newId(), start: at + c.start, end: Math.min(at + c.end, at + dur), words: c.words?.map((w) => ({ ...w, start: at + w.start, end: at + w.end })), linkedClipId: clip.id })
          x.captions.segments.sort((a, b) => a.start - b.start)
        })
        cursor = at + dur + quantize(250 * 705_600, d.settings.fps) // pausa de ~0,25 s
      }
      return out
    })
    if (ok.length) toast(`${ok.length} frase(s) inseridas na trilha de narração com legendas.`, 'ok')
  }

  const selected = selection.length === 1 ? findClip(doc, selection[0]!) : null
  const narration = selected && selected.track.kind === 'voice' && selected.clip.type === 'audio' ? selected.clip : null

  return (
    <div className="p-3 flex flex-col gap-3 text-sm">
      {dialog}
      {!providers ? null : !adapter ? (
        <p className="text-[12px] text-[var(--color-muted)]">
          <Badge tone="warn">Configuração pendente</Badge> Nenhum provedor de voz configurado. Defina ELEVENLABS_API_KEY no servidor ou grave/envie sua narração na aba Mídia.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Provedor" htmlFor="tp">
              <Select id="tp" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {providers.tts
                  .filter((p) => p.configured)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} {p.mode === 'mock' ? '(teste)' : ''}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Voz" htmlFor="tv">
              <Select id="tv" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {model && <Slider label="Velocidade" value={speed} min={model.speedRange[0]} max={model.speedRange[1]} step={0.05} format={(v) => `${v.toFixed(2).replace('.', ',')}×`} onChange={setSpeed} />}
          <p className="text-[11px] text-[var(--color-muted)]">{model?.timestamps ? 'Este modelo devolve tempo por caractere: legendas palavra a palavra reais.' : 'Sem tempo por palavra: legendas por frase (limites exatos do áudio).'}</p>
          {doc.scenes.some((s) => s.narration.trim()) && (
            <Button size="sm" onClick={() => setScript(doc.scenes.map((s) => s.narration.trim()).filter(Boolean).join('\n\n'))}>
              Usar a narração das cenas do storyboard
            </Button>
          )}
          <Field label="Texto da narração" htmlFor="scr" hint={`${sentences.length} frase(s) · ~${Math.round(sentences.reduce((a, s) => a + estimateNarrationSeconds(s, speed), 0))} s estimados`}>
            <TextArea id="scr" className="min-h-[140px]" value={script} onChange={(e) => setScript(e.target.value)} placeholder="Cole o roteiro. Ele será dividido em frases; cada frase vira um clipe que pode ser regenerado sozinho." />
          </Field>
          <Button variant="primary" icon={<Wand2 size={16} />} disabled={!sentences.length || !voiceId} loading={busy} onClick={generateAll}>
            {progress ? `Gerando ${progress}` : 'Gerar narração a partir do cursor'}
          </Button>
        </>
      )}
      {narration && adapter && model && <SentenceEditor clipId={narration.id} provider={adapter.id} model={model.id} voiceId={voiceId} speed={speed} run={run} busy={busy} fetchAsset={fetchAsset} />}
      {!narration && <p className="text-[12px] text-[var(--color-muted)]">Selecione um clipe da trilha de narração para editar e regenerar apenas aquela frase.</p>}
    </div>
  )
}

function SentenceEditor({ clipId, provider, model, voiceId, speed, run, busy, fetchAsset }: { clipId: string; provider: string; model: string; voiceId: string; speed: number; run: ReturnType<typeof useGeneration>['run']; busy: boolean; fetchAsset: (id: string) => Promise<AssetDto> }) {
  const doc = useDoc()
  const { apply, workspaceId } = useEditor()
  const toast = useToast()
  const found = findClip(doc, clipId)!
  const clip = found.clip as Extract<typeof found.clip, { type: 'audio' }>
  const linked = doc.captions.segments.filter((s) => s.linkedClipId === clipId)
  const [text, setText] = useState(linked.map((s) => s.text).join(' ') || clip.name)
  const [mode, setMode] = useState<'preserve' | 'shift'>('shift')
  const [versions, setVersions] = useState<GenerationDto[]>([])
  useEffect(() => {
    setText(doc.captions.segments.filter((s) => s.linkedClipId === clipId).map((s) => s.text).join(' ') || clip.name)
    if (!clip.sceneKey) return setVersions([])
    api<GenerationDto[]>(`/workspaces/${workspaceId}/generations?kind=TTS`)
      .then((all) => setVersions(all.filter((g) => g.input.sentenceKey === clip.sceneKey && g.status === 'succeeded')))
      .catch(() => undefined)
    // recarrega ao trocar de clipe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId])

  function useResult(g: GenerationDto) {
    const res = g.result as { durationFlicks: number; captions: CaptionSegment[] }
    apply((d) => {
      const r = replaceSentenceAudio(d, clipId, g.resultAssetId!, res.durationFlicks, mode)
      if (r.warning) toast(r.warning, 'danger')
      const c = findClip(r.doc, clipId)!.clip as typeof clip
      return produce(r.doc, (x) => {
        x.captions.segments = x.captions.segments.filter((s) => s.linkedClipId !== clipId)
        for (const s of res.captions) {
          // com aceleração (preservar espaço), os tempos encolhem na mesma proporção
          const k = 1 / c.speed
          x.captions.segments.push({ ...s, id: newId(), start: c.start + Math.round(s.start * k), end: Math.min(clipEnd(c), c.start + Math.round(s.end * k)), words: s.words?.map((w) => ({ ...w, start: c.start + Math.round(w.start * k), end: c.start + Math.round(w.end * k) })), linkedClipId: clipId })
        }
        x.captions.segments.sort((a, b) => a.start - b.start)
        const cc = x.tracks.flatMap((t) => t.clips).find((y) => y.id === clipId)
        if (cc) cc.name = text.slice(0, 200)
      })
    })
  }

  async function regenerate() {
    const key = clip.sceneKey ?? newId().slice(0, 12)
    const [g] = await run([{ kind: 'TTS', provider, model, voiceId, text, speed, sentenceKey: key }], 'Regenerar somente esta frase (as versões anteriores ficam guardadas).')
    if (!g) return
    if (g.status !== 'succeeded' || !g.resultAssetId) return toast(g.error ?? 'Falha ao gerar.', 'danger')
    await fetchAsset(g.resultAssetId)
    if (!clip.sceneKey) apply((d) => produce(d, (x) => void x.tracks.forEach((t) => t.clips.forEach((c) => c.id === clipId && (c.sceneKey = key)))))
    useResult(g)
    setVersions((v) => [g, ...v])
    toast('Frase substituída.', 'ok')
  }

  return (
    <section className="rounded-lg border border-[var(--color-accent)]/50 p-3 flex flex-col gap-2">
      <h3 className="font-medium flex items-center gap-1">
        <RefreshCw size={14} /> Frase selecionada ({formatClock(clip.start)})
      </h3>
      <TextArea aria-label="Texto da frase" value={text} onChange={(e) => setText(e.target.value)} />
      <fieldset className="flex flex-col gap-1 text-[13px]">
        <legend className="text-[12px] text-[var(--color-muted)] mb-1">Se a nova frase tiver outra duração:</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="mode" checked={mode === 'shift'} onChange={() => setMode('shift')} /> Deslocar os elementos seguintes
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="mode" checked={mode === 'preserve'} onChange={() => setMode('preserve')} /> Preservar o espaço original (acelera até 1,25×)
        </label>
      </fieldset>
      <Button variant="primary" loading={busy} disabled={!text.trim() || !voiceId} onClick={regenerate}>
        Regenerar só esta frase
      </Button>
      {versions.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-[12px] text-[var(--color-muted)] flex items-center gap-1">
            <History size={12} /> Versões anteriores
          </h4>
          {versions.map((v) => (
            <div key={v.id} className="flex items-center gap-2 text-[12px]">
              <span className="truncate flex-1" title={String(v.input.text)}>
                {new Date(v.createdAt).toLocaleTimeString('pt-BR')} — {String(v.input.text).slice(0, 40)}
              </span>
              <Button size="sm" variant="ghost" disabled={v.resultAssetId === clip.assetId} onClick={async () => {
                try {
                  await fetchAsset(v.resultAssetId!)
                  useResult(v)
                } catch (err) {
                  toast(errorMessage(err), 'danger')
                }
              }}>
                {v.resultAssetId === clip.assetId ? 'Em uso' : 'Usar'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
