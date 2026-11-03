'use client'
import { Badge, Button, Spinner, Tabs, formatCents, useToast } from '@orion/ui'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { GenerationDto, RenderDto } from '@/lib/types'

const TONE = { queued: 'neutral', running: 'info', succeeded: 'ok', failed: 'danger', canceled: 'warn' } as const
const LABEL = { queued: 'Na fila', running: 'Processando', succeeded: 'Concluído', failed: 'Falhou', canceled: 'Cancelado' } as const
const KIND: Record<string, string> = { VIDEO: 'Vídeo', IMAGE: 'Imagem', TTS: 'Voz', TRANSCRIPTION: 'Transcrição', SCRIPT: 'Roteiro', MUSIC: 'Música' }

export default function HistoryPage() {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const [tab, setTab] = useState<'renders' | 'generations'>('renders')
  const [renders, setRenders] = useState<RenderDto[] | null>(null)
  const [gens, setGens] = useState<GenerationDto[] | null>(null)
  useEffect(() => {
    const load = () => {
      api<RenderDto[]>(`/workspaces/${ws.id}/renders`).then(setRenders).catch((e) => toast(errorMessage(e), 'danger'))
      api<GenerationDto[]>(`/workspaces/${ws.id}/generations`).then(setGens).catch(() => undefined)
    }
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [ws.id, toast])
  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-5">
      <h1 className="font-display text-2xl font-bold">Gerações e exportações</h1>
      <Tabs label="Histórico" value={tab} onChange={setTab} tabs={[{ id: 'renders', label: 'Exportações' }, { id: 'generations', label: 'Gerações por IA' }]} />
      {tab === 'renders' ? (
        renders === null ? <Spinner /> : (
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-surface)] text-left text-[12px] text-[var(--color-muted)]"><tr><th className="p-3">Projeto</th><th className="p-3">Situação</th><th className="p-3">Configuração</th><th className="p-3">Criada</th><th className="p-3">Detalhe</th><th className="p-3"><span className="sr-only">Ações</span></th></tr></thead>
              <tbody>
                {renders.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--color-border)]">
                    <td className="p-3"><Link className="underline" href={`/projects/${r.projectId}`}>{r.projectName}</Link></td>
                    <td className="p-3"><Badge tone={TONE[r.status]}>{LABEL[r.status]}{r.status === 'running' ? ` ${Math.round(r.progress * 100)}%` : ''}</Badge></td>
                    <td className="p-3">{r.preset.resolution} · legendas {r.preset.captions}</td>
                    <td className="p-3">{new Date(r.createdAt).toLocaleString('pt-BR')}</td>
                    <td className="p-3 text-[12px] text-[var(--color-muted)] max-w-xs truncate" title={r.error ?? r.stage ?? ''}>{r.error ?? r.stage}</td>
                    <td className="p-3">{r.status === 'succeeded' && <Button size="sm" onClick={async () => { const d = await api<RenderDto>(`/renders/${r.id}`); if (d.downloadUrl) location.href = d.downloadUrl; else toast('Arquivo expirado pela política de retenção.', 'danger') }}>Baixar</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : gens === null ? <Spinner /> : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface)] text-left text-[12px] text-[var(--color-muted)]"><tr><th className="p-3">Tipo</th><th className="p-3">Provedor / modelo</th><th className="p-3">Situação</th><th className="p-3">Custo estimado</th><th className="p-3">Custo confirmado</th><th className="p-3">Quando</th></tr></thead>
            <tbody>
              {gens.map((g) => (
                <tr key={g.id} className="border-t border-[var(--color-border)]">
                  <td className="p-3">{KIND[g.kind]} {g.approved && <Badge tone="ok">aprovado</Badge>}</td>
                  <td className="p-3">{g.provider} · {g.model}</td>
                  <td className="p-3"><Badge tone={TONE[g.status]}>{LABEL[g.status]}</Badge>{g.error && <div className="text-[11px] text-[var(--color-danger)] max-w-xs">{g.error}</div>}</td>
                  <td className="p-3 tabular-nums">{formatCents(g.estimatedCostCents)}</td>
                  <td className="p-3 tabular-nums">{formatCents(g.confirmedCostCents)}</td>
                  <td className="p-3">{new Date(g.createdAt).toLocaleString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
