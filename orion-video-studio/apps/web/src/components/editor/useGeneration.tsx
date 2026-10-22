'use client'
import type { EstimateResponse, GenerationRequest } from '@orion/shared'
import { Badge, Button, Dialog, formatCents, useToast } from '@orion/ui'
import { useCallback, useRef, useState } from 'react'
import { api, errorMessage, newKey } from '@/lib/api'
import type { GenerationDto } from '@/lib/types'

/**
 * Fluxo obrigatório para operações pagas: estimar → mostrar custo (ou
 * ausência de preço confiável) e saldo → usuário confirma → criar com chave
 * de idempotência → acompanhar até concluir. Nenhum sucesso é simulado:
 * integrações sem credencial retornam "configuração pendente".
 */
export function useGeneration(workspaceId: string, projectId?: string) {
  const toast = useToast()
  const [pending, setPending] = useState<{ requests: GenerationRequest[]; estimates: EstimateResponse[]; label: string } | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const [busy, setBusy] = useState(false)

  const confirmCost = useCallback(
    async (requests: GenerationRequest[], label: string): Promise<EstimateResponse[] | null> => {
      try {
        const estimates = await Promise.all(requests.map((r) => api<EstimateResponse>(`/workspaces/${workspaceId}/generations/estimate`, { body: { request: r } })))
        const notConfigured = estimates.find((e) => !e.configured)
        if (notConfigured) {
          toast(`Integração "${notConfigured.provider}" com configuração pendente. Veja Integrações.`, 'danger')
          return null
        }
        setPending({ requests, estimates, label })
        const ok = await new Promise<boolean>((res) => {
          resolver.current = res
        })
        setPending(null)
        return ok ? estimates : null
      } catch (err) {
        toast(errorMessage(err), 'danger')
        return null
      }
    },
    [workspaceId, toast],
  )

  const waitFor = useCallback(async (id: string, onUpdate?: (g: GenerationDto) => void): Promise<GenerationDto> => {
    for (;;) {
      const g = await api<GenerationDto>(`/generations/${id}`)
      onUpdate?.(g)
      if (g.status === 'succeeded' || g.status === 'failed' || g.status === 'canceled') return g
      await new Promise((r) => setTimeout(r, 2000))
    }
  }, [])

  /** Executa N gerações após uma única confirmação de custo total. */
  const run = useCallback(
    async (requests: GenerationRequest[], label: string, onUpdate?: (i: number, g: GenerationDto) => void): Promise<Array<GenerationDto | null>> => {
      const estimates = await confirmCost(requests, label)
      if (!estimates) return requests.map(() => null)
      setBusy(true)
      try {
        const created = await Promise.all(
          requests.map(async (r, i) => {
            try {
              const g = await api<GenerationDto>(`/workspaces/${workspaceId}/generations`, { body: { request: r, idempotencyKey: newKey(), acceptEstimatedCents: estimates[i]!.estimatedCents, ...(projectId ? { projectId } : {}) } })
              if (g.reused) toast('Resultado aprovado reutilizado (sem novo custo).', 'ok')
              return g
            } catch (err) {
              toast(errorMessage(err), 'danger')
              return null
            }
          }),
        )
        return await Promise.all(created.map((g, i) => (g ? waitFor(g.id, (u) => onUpdate?.(i, u)) : Promise.resolve(null))))
      } finally {
        setBusy(false)
      }
    },
    [confirmCost, waitFor, workspaceId, projectId, toast],
  )

  const total = pending?.estimates.reduce<number | null>((a, e) => (a === null || e.estimatedCents === null ? null : a + e.estimatedCents), 0)
  const dialog = (
    <Dialog
      open={!!pending}
      onClose={() => resolver.current?.(false)}
      title="Confirmar custo antes de gerar"
      footer={
        <>
          <Button onClick={() => resolver.current?.(false)}>Cancelar</Button>
          <Button variant="primary" onClick={() => resolver.current?.(true)}>
            Confirmar e gerar
          </Button>
        </>
      }
    >
      {pending && (
        <div className="flex flex-col gap-3 text-sm">
          <p>{pending.label}</p>
          <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-1">
            <div className="flex justify-between">
              <span className="text-[var(--color-muted)]">Operações</span>
              <span>{pending.requests.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--color-muted)]">Custo estimado</span>
              <span className="font-semibold">{total === null ? 'Sem dado confiável de preço' : formatCents(total)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--color-muted)]">Saldo do mês após a operação</span>
              <span>{formatCents((pending.estimates[0]?.remainingBudgetCents ?? 0) - (total ?? 0))}</span>
            </div>
          </div>
          <p className="text-[12px] text-[var(--color-muted)]">{pending.estimates[0]?.basis}</p>
          <p className="text-[12px] text-[var(--color-muted)]">
            <Badge tone="info">Estimado</Badge> O valor confirmado é calculado após a conclusão com a quantidade realmente produzida.
          </p>
        </div>
      )}
    </Dialog>
  )
  return { run, waitFor, dialog, busy }
}
