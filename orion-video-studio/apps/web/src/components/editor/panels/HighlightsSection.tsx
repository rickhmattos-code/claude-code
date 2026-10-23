'use client'
import type { AspectPreset } from '@orion/shared'
import { FLICKS_PER_SECOND, type Highlight, type PeakData, docDuration, energyCurve, formatClock, suggestHighlights } from '@orion/timeline'
import { Badge, Button, Select, useToast } from '@orion/ui'
import { Clapperboard, Play } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { loadPeaks } from '../Timeline'
import { useDoc, useEditor } from '../store'

/**
 * Cortes curtos: sugere trechos de 15–60 s a partir da transcrição e da
 * energia do áudio, e cria um novo projeto com o trecho escolhido.
 */
export function HighlightsSection() {
  const doc = useDoc()
  const { assets, projectId, name, baseVersion, saveState, setPlayhead, setPlaying } = useEditor()
  const toast = useToast()
  const router = useRouter()
  const [items, setItems] = useState<Highlight[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState<number | null>(null)
  const [aspect, setAspect] = useState<AspectPreset>('9:16')
  const longEnough = docDuration(doc) >= 30 * FLICKS_PER_SECOND

  async function analyze() {
    setBusy(true)
    try {
      const peaks = new Map<string, PeakData>()
      const ids = new Set(doc.tracks.flatMap((t) => t.clips.flatMap((c) => ('assetId' in c ? [c.assetId] : []))))
      await Promise.all(
        [...ids].map(async (id) => {
          const a = assets[id]
          if (!a?.waveformUrl) return
          const data = await loadPeaks(a.waveformUrl, id)
          if (data) peaks.set(id, data)
        }),
      )
      setItems(suggestHighlights(doc, { energy: energyCurve(doc, peaks), count: 3 }))
    } finally {
      setBusy(false)
    }
  }

  async function create(h: Highlight, index: number) {
    setCreating(index)
    try {
      const p = await api<{ id: string }>(`/projects/${projectId}/derive`, {
        body: { name: `${name} — corte ${index + 1}`.slice(0, 120), baseVersion, start: h.start, end: h.end, aspect },
      })
      toast('Corte criado como novo projeto.', 'ok')
      router.push(`/projects/${p.id}`)
    } catch (err) {
      toast(errorMessage(err), 'danger')
    } finally {
      setCreating(null)
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2" aria-label="Cortes curtos">
      <h3 className="font-medium flex items-center gap-1">
        <Clapperboard size={14} /> Cortes curtos a partir deste vídeo
      </h3>
      <p className="text-[12px] text-[var(--color-muted)]">
        Sugestões de 15 a 60 s por cobertura de fala, ritmo, gancho na primeira frase e energia do áudio. É um ponto de partida: revise antes de publicar.
      </p>
      {doc.captions.segments.length === 0 ? (
        <p className="text-[12px] text-[var(--color-muted)]">Precisa de transcrição ou legendas para sugerir trechos.</p>
      ) : !longEnough ? (
        <p className="text-[12px] text-[var(--color-muted)]">O projeto tem menos de 30 s.</p>
      ) : (
        <>
          <div className="flex gap-2 items-center">
            <Button size="sm" loading={busy} onClick={analyze}>
              {items ? 'Analisar de novo' : 'Sugerir trechos'}
            </Button>
            <Select aria-label="Formato do corte" value={aspect} onChange={(e) => setAspect(e.target.value as AspectPreset)} className="w-28">
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
              <option value="4:5">4:5</option>
              <option value="16:9">16:9</option>
            </Select>
          </div>
          {items?.length === 0 && <p className="text-[12px] text-[var(--color-muted)]">Nenhum trecho de 15–60 s com fala suficiente.</p>}
          <ol className="flex flex-col gap-2">
            {items?.map((h, i) => (
              <li key={`${h.start}-${h.end}`} className="rounded border border-[var(--color-border)] p-2 flex flex-col gap-1">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="tabular-nums">
                    {formatClock(h.start)} → {formatClock(h.end)}
                  </span>
                  <span className="text-[var(--color-muted)]">({Math.round((h.end - h.start) / FLICKS_PER_SECOND)} s)</span>
                  <Badge tone={h.score >= 70 ? 'ok' : 'neutral'}>nota {h.score}</Badge>
                </div>
                <p className="text-[12px] italic">“{h.excerpt}{h.excerpt.length >= 160 ? '…' : ''}”</p>
                {h.reasons.length > 0 && <p className="text-[11px] text-[var(--color-muted)]">{h.reasons.join(' · ')}</p>}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Play size={12} />}
                    onClick={() => {
                      setPlayhead(h.start)
                      setPlaying(true)
                    }}
                  >
                    Ouvir
                  </Button>
                  <Button size="sm" variant="primary" disabled={saveState !== 'saved'} loading={creating === i} onClick={() => create(h, i)}>
                    {saveState === 'saved' ? `Criar projeto ${aspect}` : 'Aguardando salvar…'}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
