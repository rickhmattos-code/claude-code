'use client'
import type { CaptionSegment, CaptionStyle } from '@orion/shared'
import {
  FLICKS_PER_SECOND,
  addCaption,
  clipEnd,
  formatClock,
  mergeCaptions,
  newId,
  parseSubtitles,
  quantize,
  removeCaption,
  secondsToFlicks,
  splitCaption,
  toSrt,
  updateCaption,
} from '@orion/timeline'
import { Badge, Button, Field, Input, Select, Slider, TextArea, useToast } from '@orion/ui'
import { produce } from 'immer'
import { Download, FileUp, Languages, Merge, Mic2, Plus, Scissors, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { ProvidersDto } from '@/lib/types'
import { useDoc, useEditor } from '../store'
import { useGeneration } from '../useGeneration'

const toSec = (f: number) => (f / FLICKS_PER_SECOND).toFixed(2)

export function CaptionsPanel() {
  const doc = useDoc()
  const { apply, playhead, setPlayhead, selectedCaptionId, selectCaption, projectId, workspaceId, assets } = useEditor()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const { run, dialog, busy } = useGeneration(workspaceId, projectId)
  const [providers, setProviders] = useState<ProvidersDto | null>(null)
  const [source, setSource] = useState('')
  useEffect(() => {
    api<ProvidersDto>('/providers').then(setProviders).catch(() => undefined)
  }, [])
  const style = doc.captionStyles.find((s) => s.id === doc.captions.styleId) ?? doc.captionStyles[0]!
  const setStyle = (patch: Partial<CaptionStyle>) =>
    apply(
      (d) =>
        produce(d, (x) => {
          Object.assign(x.captionStyles.find((s) => s.id === style.id)!, patch)
        }),
      { coalesce: `capstyle:${Object.keys(patch).join()}` },
    )
  const fps = doc.settings.fps
  const audioClips = doc.tracks.flatMap((t) => t.clips.map((c) => ({ c, t }))).filter(({ c }) => (c.type === 'audio' || c.type === 'video') && 'assetId' in c && assets[c.assetId]?.hasAudio)
  const stt = providers?.transcription.find((p) => p.configured)

  async function transcribe() {
    const found = audioClips.find(({ c }) => c.id === source)
    if (!found || !stt || !('assetId' in found.c)) return
    const clip = found.c
    const [g] = await run([{ kind: 'TRANSCRIPTION', provider: stt.id, model: stt.models[0]!.id, assetId: clip.assetId, language: 'pt' }], `Transcrever o áudio de “${clip.name}” com ${stt.label}.`)
    if (!g) return
    if (g.status !== 'succeeded') return toast(g.error ?? 'Transcrição falhou.', 'danger')
    const segs = ((g.result as { captions?: CaptionSegment[] })?.captions ?? []) as CaptionSegment[]
    // mapeia tempo da mídia → tempo da timeline e vincula ao clipe
    const map = (t: number) => clip.start + Math.round((t - clip.sourceIn) / clip.speed)
    apply((d) =>
      produce(d, (x) => {
        x.captions.segments = x.captions.segments.filter((s) => s.linkedClipId !== clip.id)
        for (const s of segs) {
          const start = map(s.start)
          const end = map(s.end)
          if (end <= clip.start || start >= clipEnd(clip)) continue
          x.captions.segments.push({ ...s, id: newId(), start: Math.max(clip.start, start), end: Math.min(clipEnd(clip), end), words: s.words?.map((w) => ({ ...w, start: map(w.start), end: map(w.end) })), linkedClipId: clip.id })
        }
        x.captions.segments.sort((a, b) => a.start - b.start)
      }),
    )
    toast(`${segs.length} segmentos importados${(g.result as { wordTimestamps?: boolean })?.wordTimestamps ? ' com tempo por palavra' : ' (sem tempo por palavra)'}.`, 'ok')
  }

  return (
    <div className="p-3 flex flex-col gap-3 text-sm">
      {dialog}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Plus size={14} />} onClick={() => apply((d) => addCaption(d, { start: quantize(playhead, fps), end: quantize(playhead + secondsToFlicks(2), fps), text: 'Nova legenda' }))}>
          Adicionar no cursor
        </Button>
        <Button size="sm" icon={<FileUp size={14} />} onClick={() => fileRef.current?.click()}>
          Importar SRT/VTT
        </Button>
        <a href={`/api/projects/${projectId}/captions.srt`} className="inline-flex">
          <Button size="sm" icon={<Download size={14} />}>
            SRT
          </Button>
        </a>
        <a href={`/api/projects/${projectId}/captions.vtt`} className="inline-flex">
          <Button size="sm" icon={<Download size={14} />}>
            VTT
          </Button>
        </a>
        <input
          ref={fileRef}
          type="file"
          accept=".srt,.vtt,text/vtt,application/x-subrip"
          hidden
          aria-label="Arquivo de legendas"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            try {
              const segs = parseSubtitles(await f.text())
              if (!segs.length) throw new Error('Nenhuma legenda válida encontrada no arquivo.')
              apply((d) => produce(d, (x) => void (x.captions.segments = [...x.captions.segments, ...segs].sort((a, b) => a.start - b.start))))
              toast(`${segs.length} legendas importadas.`, 'ok')
            } catch (err) {
              toast(errorMessage(err), 'danger')
            }
            e.target.value = ''
          }}
        />
      </div>
      <section className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2">
        <h3 className="font-medium flex items-center gap-1">
          <Mic2 size={14} /> Transcrição automática
        </h3>
        {!stt ? (
          <p className="text-[12px] text-[var(--color-muted)]">
            <Badge tone="warn">Configuração pendente</Badge> Configure um provedor de transcrição (ex.: OPENAI_API_KEY) no servidor.
          </p>
        ) : (
          <>
            <Select aria-label="Clipe a transcrever" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Escolha um clipe com áudio…</option>
              {audioClips.map(({ c, t }) => (
                <option key={c.id} value={c.id}>
                  {t.name}: {c.name} ({formatClock(c.start)})
                </option>
              ))}
            </Select>
            <Button size="sm" variant="primary" disabled={!source} loading={busy} onClick={transcribe}>
              Transcrever com {stt.label} {stt.mode === 'mock' ? '(MODO DE TESTE)' : ''}
            </Button>
          </>
        )}
      </section>
      <TranslateSection providers={providers} />
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={doc.captions.burnIn} onChange={(e) => apply((d) => ({ ...d, captions: { ...d.captions, burnIn: e.target.checked } }))} />
        Mostrar na prévia e gravar no vídeo
      </label>
      <details className="rounded-lg border border-[var(--color-border)] p-3">
        <summary className="cursor-pointer font-medium">Estilo das legendas</summary>
        <div className="flex flex-col gap-3 pt-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Fonte" htmlFor="cf">
              <Select id="cf" value={style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value as CaptionStyle['fontFamily'] })}>
                <option>Inter</option>
                <option>Inter Display</option>
              </Select>
            </Field>
            <Field label="Peso" htmlFor="cw">
              <Select id="cw" value={style.fontWeight} onChange={(e) => setStyle({ fontWeight: Number(e.target.value) as CaptionStyle['fontWeight'] })}>
                <option value={400}>Normal</option>
                <option value={600}>Seminegrito</option>
                <option value={700}>Negrito</option>
                <option value={800}>Extranegrito</option>
              </Select>
            </Field>
          </div>
          <Slider label="Tamanho" value={style.fontSize} min={12} max={160} step={1} format={(v) => String(Math.round(v))} onChange={(v) => setStyle({ fontSize: Math.round(v) })} />
          <div className="grid grid-cols-3 gap-2">
            <Field label="Cor" htmlFor="cc1">
              <Input id="cc1" type="color" value={style.color.slice(0, 7)} onChange={(e) => setStyle({ color: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Destaque" htmlFor="cc2">
              <Input id="cc2" type="color" value={style.highlightColor.slice(0, 7)} onChange={(e) => setStyle({ highlightColor: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Contorno" htmlFor="cc3">
              <Input id="cc3" type="color" value={style.outlineColor.slice(0, 7)} onChange={(e) => setStyle({ outlineColor: e.target.value.toUpperCase() })} />
            </Field>
          </div>
          <Slider label="Contorno" value={style.outlineWidth} min={0} max={12} step={0.5} onChange={(v) => setStyle({ outlineWidth: v })} />
          <Slider label="Sombra" value={style.shadow} min={0} max={12} step={0.5} onChange={(v) => setStyle({ shadow: v })} />
          <Slider label="Posição vertical" value={style.positionY} min={0.05} max={0.95} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setStyle({ positionY: v })} />
          <Slider label="Margem lateral" value={style.marginX} min={0} max={0.4} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setStyle({ marginX: v })} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={style.background !== null} onChange={(e) => setStyle({ background: e.target.checked ? '#000000' : null })} /> Caixa de fundo
            {style.background && <Input type="color" aria-label="Cor do fundo" className="w-16" value={style.background.slice(0, 7)} onChange={(e) => setStyle({ background: e.target.value.toUpperCase() })} />}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={style.uppercase} onChange={(e) => setStyle({ uppercase: e.target.checked })} /> Maiúsculas
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={style.highlightWords} onChange={(e) => setStyle({ highlightWords: e.target.checked })} /> Destacar palavra falada <Badge>só com tempo por palavra real</Badge>
          </label>
        </div>
      </details>
      <ul className="flex flex-col gap-2" aria-label="Segmentos de legenda">
        {doc.captions.segments.map((s, i) => {
          const next = doc.captions.segments[i + 1]
          const active = selectedCaptionId === s.id
          return (
            <li key={s.id} className={`rounded-lg border p-2 flex flex-col gap-1.5 ${active ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
              <div className="flex items-center gap-1 text-[11px]">
                <button className="tabular-nums text-[var(--color-blue)] underline" onClick={() => setPlayhead(s.start)}>
                  {formatClock(s.start)}
                </button>
                <span className="text-[var(--color-muted)]">→ {formatClock(s.end)}</span>
                {s.words && <Badge tone="info">palavra a palavra</Badge>}
                {s.linkedClipId && <Badge>vinculada</Badge>}
                <span className="ml-auto flex gap-0.5">
                  <IconBtn label="Dividir no cursor" disabled={!(playhead > s.start && playhead < s.end)} onClick={() => apply((d) => splitCaption(d, s.id, quantize(playhead, fps)))} icon={<Scissors size={12} />} />
                  <IconBtn label="Unir com a próxima" disabled={!next} onClick={() => next && apply((d) => mergeCaptions(d, s.id, next.id))} icon={<Merge size={12} />} />
                  <IconBtn label="Excluir legenda" onClick={() => apply((d) => removeCaption(d, s.id))} icon={<Trash2 size={12} />} />
                </span>
              </div>
              <TextArea aria-label="Texto da legenda" className="min-h-[44px] text-[13px]" value={s.text} onFocus={() => selectCaption(s.id)} onChange={(e) => apply((d) => updateCaption(d, s.id, { text: e.target.value }), { coalesce: `cap:${s.id}` })} />
              <div className="grid grid-cols-2 gap-2">
                <Input type="number" step={0.05} aria-label="Início (s)" value={toSec(s.start)} onChange={(e) => apply((d) => updateCaption(d, s.id, { start: secondsToFlicks(Number(e.target.value)) }), { coalesce: `cs:${s.id}` })} />
                <Input type="number" step={0.05} aria-label="Fim (s)" value={toSec(s.end)} onChange={(e) => apply((d) => updateCaption(d, s.id, { end: secondsToFlicks(Number(e.target.value)) }), { coalesce: `ce:${s.id}` })} />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const LANGS: Array<[string, string]> = [
  ['en', 'Inglês'],
  ['es', 'Espanhol'],
  ['fr', 'Francês'],
  ['it', 'Italiano'],
  ['de', 'Alemão'],
  ['pt-PT', 'Português (Portugal)'],
  ['pt-BR', 'Português (Brasil)'],
]

/** Tradução por IA: tempos preservados; aplicar substitui o texto (com desfazer) ou baixa um SRT. */
function TranslateSection({ providers }: { providers: ProvidersDto | null }) {
  const doc = useDoc()
  const { apply, projectId } = useEditor()
  const toast = useToast()
  const [target, setTarget] = useState('en')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ target: string; mode: string; segments: CaptionSegment[] } | null>(null)
  const t = providers?.translation
  const segs = doc.captions.segments
  async function translate() {
    setBusy(true)
    try {
      const r = await api<{ target: string; mode: string; segments: CaptionSegment[] }>(`/projects/${projectId}/captions/translate`, {
        body: { target, segments: segs.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text })) },
      })
      setResult(r)
    } catch (err) {
      toast(errorMessage(err), 'danger')
    } finally {
      setBusy(false)
    }
  }
  function replace() {
    if (!result) return
    const byId = new Map(result.segments.map((s) => [s.id, s.text]))
    apply((d) =>
      produce(d, (x) => {
        for (const s of x.captions.segments) {
          const tx = byId.get(s.id)
          if (tx !== undefined) {
            s.text = tx
            s.words = undefined
          }
        }
      }),
    )
    setResult(null)
    toast('Legendas substituídas pela tradução. Use Desfazer para voltar ao original.', 'ok')
  }
  function download() {
    if (!result) return
    const blob = new Blob([toSrt(result.segments)], { type: 'application/x-subrip;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `legendas-${result.target}.srt`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <section className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2" aria-label="Tradução de legendas">
      <h3 className="font-medium flex items-center gap-1">
        <Languages size={14} /> Traduzir legendas
      </h3>
      {!t?.configured ? (
        <p className="text-[12px] text-[var(--color-muted)]">
          <Badge tone="warn">Configuração pendente</Badge> Defina ANTHROPIC_API_KEY no servidor para traduzir.
        </p>
      ) : segs.length === 0 ? (
        <p className="text-[12px] text-[var(--color-muted)]">Nenhuma legenda para traduzir.</p>
      ) : (
        <>
          <div className="flex gap-2">
            <Select aria-label="Idioma de destino" value={target} onChange={(e) => setTarget(e.target.value)}>
              {LANGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="primary" loading={busy} onClick={translate}>
              Traduzir {segs.length} {t.mode === 'mock' ? '(MODO DE TESTE)' : ''}
            </Button>
          </div>
          <p className="text-[11px] text-[var(--color-muted)]">Os tempos são mantidos. O destaque palavra a palavra deixa de valer no texto traduzido. Revise antes de publicar.</p>
          {result && (
            <div className="flex flex-col gap-2">
              <ul className="max-h-40 overflow-auto text-[12px] flex flex-col gap-1" aria-label="Prévia da tradução">
                {result.segments.slice(0, 50).map((s, i) => (
                  <li key={s.id}>
                    <span className="text-[var(--color-muted)] line-through mr-1">{segs[i]?.text}</span> {s.text}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={replace}>
                  Substituir legendas
                </Button>
                <Button size="sm" icon={<Download size={14} />} onClick={download}>
                  Baixar SRT ({result.target})
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function IconBtn({ label, icon, onClick, disabled }: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button aria-label={label} title={label} disabled={disabled} onClick={onClick} className="w-7 h-7 inline-flex items-center justify-center rounded hover:bg-[var(--color-surface-2)] disabled:opacity-30">
      {icon}
    </button>
  )
}
