'use client'
import { EFFECT_SUPPORT, PLANNED_EFFECTS, TRANSITION_SUPPORT } from '@orion/shared'
import { Badge, ProgressBar, Spinner, formatBytes, formatCents } from '@orion/ui'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useSession, useT } from '@/lib/session'
import type { ProvidersDto } from '@/lib/types'

interface Usage {
  budgetCents: number
  confirmedCents: number
  estimatedPendingCents: number
  storageUsedBytes: number
  storageQuotaBytes: number
  entries: Array<{ id: string; kind: string; provider: string; estimatedCents: number; confirmedCents: number | null; status: string; createdAt: string }>
}

export default function ProvidersPage() {
  const t = useT()
  const ws = useSession((s) => s.workspace)!
  const [p, setP] = useState<ProvidersDto | null>(null)
  const [u, setU] = useState<Usage | null>(null)
  useEffect(() => {
    api<ProvidersDto>('/providers').then(setP).catch(() => undefined)
    api<Usage>(`/workspaces/${ws.id}/usage`).then(setU).catch(() => undefined)
  }, [ws.id])
  const modeTone = { live: 'ok', mock: 'warn', 'pending-config': 'danger', local: 'info' } as const
  const modeLabel = { live: t('provider.live'), mock: t('provider.mock'), 'pending-config': t('provider.pending'), local: t('provider.local') }
  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-6">
      <header>
        <h1 className="font-display text-2xl font-bold">Integrações e consumo</h1>
        <p className="text-sm text-[var(--color-muted)]">Chaves ficam apenas no servidor (arquivo .env). Esta página nunca exibe segredos.</p>
      </header>
      {!p ? <Spinner /> : (
        <section className="grid sm:grid-cols-2 gap-3">
          {p.statuses.map((s) => (
            <div key={s.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-2">
              <div className="flex items-center gap-2"><span className="font-medium flex-1">{s.label}</span><Badge tone={modeTone[s.mode]}>{modeLabel[s.mode]}</Badge></div>
              <div className="flex gap-1 flex-wrap">{s.kinds.map((k) => <Badge key={k}>{k}</Badge>)}</div>
              <p className="text-[12px] text-[var(--color-muted)]">{s.notes}</p>
              {s.missingEnv.length > 0 && <p className="text-[12px]">Para ativar: <code className="text-[var(--color-accent)]">{s.missingEnv.join(', ')}</code></p>}
            </div>
          ))}
        </section>
      )}
      {u && (
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-3">
          <h2 className="font-semibold">Consumo do mês</h2>
          <ProgressBar value={(u.confirmedCents + u.estimatedPendingCents) / Math.max(1, u.budgetCents)} label={`IA: ${formatCents(u.confirmedCents)} confirmado + ${formatCents(u.estimatedPendingCents)} estimado em andamento, de ${formatCents(u.budgetCents)}`} />
          <ProgressBar value={u.storageUsedBytes / Math.max(1, u.storageQuotaBytes)} label={`Armazenamento: ${formatBytes(u.storageUsedBytes)} de ${formatBytes(u.storageQuotaBytes)}`} />
          <p className="text-[12px] text-[var(--color-muted)]">“Confirmado” = quantidade realmente produzida × tabela de preços configurada. Não substitui a fatura do provedor.</p>
        </section>
      )}
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-3">
        <h2 className="font-semibold">Matriz de efeitos (prévia × exportação)</h2>
        <table className="text-sm w-full">
          <thead className="text-left text-[12px] text-[var(--color-muted)]"><tr><th className="py-1">Efeito</th><th>Prévia</th><th>Exportação</th><th>Observação</th></tr></thead>
          <tbody>
            {Object.entries(EFFECT_SUPPORT).map(([k, e]) => <tr key={k} className="border-t border-[var(--color-border)]"><td className="py-1.5">{e.label}</td><td>{e.preview === 'exact' ? 'Exata' : e.preview === 'approx' ? 'Aproximada' : 'Não exibida'}</td><td>Pronto ({e.ffmpeg})</td><td className="text-[12px] text-[var(--color-muted)]">{e.notes}</td></tr>)}
            {Object.entries(TRANSITION_SUPPORT).map(([k, e]) => <tr key={k} className="border-t border-[var(--color-border)]"><td className="py-1.5">{e.label}</td><td>Exata</td><td>Pronto</td><td /></tr>)}
            {PLANNED_EFFECTS.map((e) => <tr key={e.label} className="border-t border-[var(--color-border)] text-[var(--color-muted)]"><td className="py-1.5">{e.label}</td><td>—</td><td>Fase {e.phase}</td><td className="text-[12px]">{e.dependency}; custo: {e.cost}</td></tr>)}
          </tbody>
        </table>
      </section>
    </div>
  )
}
