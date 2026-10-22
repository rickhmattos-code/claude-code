'use client'
import type { AspectPreset } from '@orion/shared'
import { formatClock } from '@orion/timeline'
import { Badge, Button, Empty, Spinner, useToast } from '@orion/ui'
import { Film, Plus, Sparkles, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useSession, useT } from '@/lib/session'
import { NewProjectDialog } from '@/components/NewProjectDialog'

interface ProjectRow {
  id: string
  name: string
  updatedAt: string
  aspect: AspectPreset
  durationFlicks: number
}

export default function ProjectsPage() {
  const t = useT()
  const toast = useToast()
  const ws = useSession((s) => s.workspace)!
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [open, setOpen] = useState(false)
  const reload = useCallback(() => {
    api<ProjectRow[]>(`/workspaces/${ws.id}/projects`)
      .then(setRows)
      .catch((e) => toast(errorMessage(e), 'danger'))
  }, [ws.id, toast])
  useEffect(reload, [reload])
  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t('nav.projects')}</h1>
          <p className="text-sm text-[var(--color-muted)]">Edite em timeline, gere cenas e exporte vídeos acima de 60 segundos.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/assistant">
            <Button icon={<Sparkles size={16} />}>Criar com assistente</Button>
          </Link>
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>
            {t('projects.new')}
          </Button>
        </div>
      </header>
      {rows === null ? (
        <div className="flex items-center gap-2 text-[var(--color-muted)]">
          <Spinner /> {t('common.loading')}
        </div>
      ) : rows.length === 0 ? (
        <Empty title={t('projects.empty')} action={<Button variant="primary" onClick={() => setOpen(true)}>{t('projects.new')}</Button>} />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {rows.map((p) => (
            <li key={p.id} className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden flex flex-col">
              <Link href={`/projects/${p.id}`} className="aspect-video bg-[var(--color-surface-2)] flex items-center justify-center text-[var(--color-faint)]" aria-label={`${t('projects.open')} ${p.name}`}>
                <Film size={32} />
              </Link>
              <div className="p-3 flex flex-col gap-2">
                <Link href={`/projects/${p.id}`} className="font-medium truncate hover:underline">
                  {p.name}
                </Link>
                <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
                  <Badge>{p.aspect}</Badge>
                  <span className="tabular-nums">{formatClock(p.durationFlicks)}</span>
                  <span className="ml-auto">{new Date(p.updatedAt).toLocaleDateString('pt-BR')}</span>
                </div>
                <div className="flex gap-2">
                  <Link href={`/projects/${p.id}`} className="flex-1">
                    <Button size="sm" className="w-full">
                      {t('projects.open')}
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={14} />}
                    aria-label={`${t('projects.delete')} ${p.name}`}
                    onClick={async () => {
                      if (!confirm(`Excluir "${p.name}"? O projeto deixa de aparecer na lista.`)) return
                      try {
                        await api(`/projects/${p.id}`, { method: 'DELETE' })
                        reload()
                      } catch (e) {
                        toast(errorMessage(e), 'danger')
                      }
                    }}
                  >
                    {t('projects.delete')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <NewProjectDialog open={open} onClose={() => setOpen(false)} />
    </div>
  )
}
