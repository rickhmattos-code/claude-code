'use client'
import {
  FLICKS_PER_SECOND,
  type TimeRange,
  type WordRef,
  cutRanges,
  findFillerWords,
  findPauses,
  formatClock,
  normalizeRanges,
  rangesDuration,
  segmentRanges,
  wordSelectionRanges,
} from '@orion/timeline'
import { Badge, Button, Empty, useToast } from '@orion/ui'
import { Eraser, Pause, Scissors } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useDoc, useEditor } from '../store'
import { HighlightsSection } from './HighlightsSection'

const secs = (f: number) => (f / FLICKS_PER_SECOND).toLocaleString('pt-BR', { maximumFractionDigits: 1 })

/**
 * Edição pelo texto: excluir palavras ou frases da transcrição corta o trecho
 * correspondente em todas as trilhas (ripple global). Palavras só são
 * selecionáveis quando há tempo por palavra real; sem isso, a unidade é o
 * segmento inteiro.
 */
export function TranscriptPanel() {
  const doc = useDoc()
  const { apply, playhead, setPlayhead } = useEditor()
  const toast = useToast()
  const [words, setWords] = useState<Set<string>>(new Set())
  const [segs, setSegs] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const segments = doc.captions.segments
  const flatKeys = useMemo(() => segments.flatMap((s) => (s.words ?? []).map((_, i) => `${s.id}:${i}`)), [segments])

  const selectedRefs: WordRef[] = [...words].map((k) => {
    const i = k.lastIndexOf(':')
    return { segmentId: k.slice(0, i), index: Number(k.slice(i + 1)) }
  })
  const ranges = normalizeRanges(doc, [...wordSelectionRanges(segments, selectedRefs), ...segmentRanges(segments, [...segs])])
  const pauses = useMemo(() => findPauses(doc), [doc])
  const fillers = useMemo(() => findFillerWords(segments), [segments])
  const hasWords = segments.some((s) => s.words?.length)

  function toggleWord(key: string, shift: boolean) {
    const next = new Set(words)
    if (shift && anchor) {
      const a = flatKeys.indexOf(anchor)
      const b = flatKeys.indexOf(key)
      if (a >= 0 && b >= 0) for (const k of flatKeys.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(k)
    } else if (next.has(key)) next.delete(key)
    else next.add(key)
    setWords(next)
    setAnchor(key)
  }
  function clear() {
    setWords(new Set())
    setSegs(new Set())
    setAnchor(null)
  }
  function cut(rs: TimeRange[], what: string) {
    if (rs.length === 0) return
    const ok = apply((d) => cutRanges(d, rs))
    if (ok) {
      clear()
      toast(`${what}: ${secs(rangesDuration(rs))} s removidos em todas as trilhas. Use Desfazer para reverter.`, 'ok')
    }
  }

  if (segments.length === 0) {
    return (
      <div className="p-3 flex flex-col gap-3">
        <Empty title="Sem transcrição">Transcreva um clipe ou importe um SRT/VTT na aba Legendas. Depois, edite o vídeo apagando palavras aqui.</Empty>
        <HighlightsSection />
      </div>
    )
  }

  return (
    <div className="p-3 flex flex-col gap-3 text-sm">
      <p className="text-[12px] text-[var(--color-muted)]">
        Selecione palavras (Shift para intervalo) ou frases e exclua: o trecho sai do vídeo, do áudio e das legendas ao mesmo tempo.
        {!hasWords && ' Estas legendas não têm tempo por palavra; a seleção é por frase.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Scissors size={14} />} disabled={ranges.length === 0} onClick={() => cut(ranges, 'Trecho excluído')}>
          Excluir seleção{ranges.length ? ` (${secs(rangesDuration(ranges))} s)` : ''}
        </Button>
        {hasWords && (
          <Button
            size="sm"
            icon={<Eraser size={14} />}
            disabled={fillers.length === 0}
            onClick={() => {
              setWords(new Set([...words, ...fillers.map((r) => `${r.segmentId}:${r.index}`)]))
              toast(`${fillers.length} palavra(s) de preenchimento selecionada(s). Revise antes de excluir.`, 'info')
            }}
          >
            Selecionar “ãh”, “hum”, “né”… ({fillers.length})
          </Button>
        )}
        <Button size="sm" icon={<Pause size={14} />} disabled={pauses.length === 0} onClick={() => cut(pauses, 'Pausas removidas')}>
          Remover pausas &gt; 0,7 s ({pauses.length}{pauses.length ? `, ${secs(rangesDuration(pauses))} s` : ''})
        </Button>
        {(words.size > 0 || segs.size > 0) && (
          <Button size="sm" variant="ghost" onClick={clear}>
            Limpar seleção
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2" aria-label="Transcrição editável">
        {segments.map((s) => {
          const segSelected = segs.has(s.id)
          return (
            <div key={s.id} className={`rounded-lg border p-2 leading-7 ${segSelected ? 'border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)]' : 'border-[var(--color-border)]'}`}>
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
                <button className="tabular-nums text-[var(--color-blue)] underline" onClick={() => setPlayhead(s.start)}>
                  {formatClock(s.start)}
                </button>
                {s.speaker && <Badge>{s.speaker}</Badge>}
                <label className="ml-auto flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={segSelected}
                    onChange={() => {
                      const n = new Set(segs)
                      if (n.has(s.id)) n.delete(s.id)
                      else n.add(s.id)
                      setSegs(n)
                    }}
                  />
                  frase inteira
                </label>
              </div>
              {s.words?.length ? (
                <p className="text-[14px]">
                  {s.words.map((w, i) => {
                    const key = `${s.id}:${i}`
                    const sel = words.has(key)
                    const live = playhead >= w.start && playhead < w.end
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={sel}
                        title={`${formatClock(w.start)} — duplo clique para ir`}
                        onClick={(e) => toggleWord(key, e.shiftKey)}
                        onDoubleClick={() => setPlayhead(w.start)}
                        className={`mr-1 rounded px-0.5 ${sel ? 'line-through bg-[color-mix(in_oklab,var(--color-danger)_25%,transparent)] text-[var(--color-danger)]' : live ? 'bg-[color-mix(in_oklab,var(--color-accent)_25%,transparent)]' : 'hover:bg-[var(--color-surface-2)]'}`}
                      >
                        {w.text}
                      </button>
                    )
                  })}
                </p>
              ) : (
                <p className={`text-[14px] ${segSelected ? 'line-through text-[var(--color-danger)]' : ''}`}>{s.text}</p>
              )}
            </div>
          )
        })}
      </div>
      <HighlightsSection />
    </div>
  )
}
