'use client'
import type { TemplateDefinition } from '@orion/shared'
import { Badge, Button, Dialog, Empty, Field, Input, Select, Spinner, TextArea, useToast } from '@orion/ui'
import { Copy, LayoutTemplate, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useSession } from '@/lib/session'

interface TemplateRow {
  id: string
  slug: string
  version: number
  name: string
  category: string
  isSystem: boolean
  workspaceId: string | null
  definition: TemplateDefinition
}

const CAT: Record<string, string> = { reflexao: 'Reflexão', vendas: 'Vendas', institucional: 'Institucional', historia: 'História narrada', educativo: 'Educativo', podcast: 'Podcast', depoimento: 'Depoimento', lista: 'Lista', produto: 'Produto', humor: 'Humor', personalizado: 'Meus modelos' }

function Storyboard({ def }: { def: TemplateDefinition }) {
  const total = def.scenes.reduce((a, s) => a + s.duration, 0)
  return (
    <div className="flex h-10 rounded-md overflow-hidden border border-[var(--color-border)]" aria-label="Estrutura de cenas">
      {def.scenes.map((s, i) => (
        <div key={s.key} className="flex items-center justify-center text-[10px] px-1 truncate border-r border-black/30" style={{ width: `${(s.duration / total) * 100}%`, background: i % 2 ? def.colors.primary : def.colors.accent, color: def.colors.background }} title={`${s.title} — ${s.duration}s`}>
          {s.title}
        </div>
      ))}
    </div>
  )
}

export default function TemplatesPage() {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const router = useRouter()
  const [rows, setRows] = useState<TemplateRow[] | null>(null)
  const [cat, setCat] = useState('all')
  const [chosen, setChosen] = useState<TemplateRow | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [aspect, setAspect] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api<TemplateRow[]>(`/templates?workspaceId=${ws.id}`).then(setRows).catch((e) => toast(errorMessage(e), 'danger')), [ws.id, toast])
  useEffect(() => {
    void load()
  }, [load])
  const shown = (rows ?? []).filter((r) => cat === 'all' || r.category === cat)

  function open(t: TemplateRow) {
    setChosen(t)
    setName(t.name)
    setAspect(t.definition.aspects[0]!)
    setValues(Object.fromEntries(t.definition.fields.filter((f) => f.type === 'text').map((f) => [f.key, f.default])))
  }
  async function create() {
    if (!chosen) return
    setBusy(true)
    try {
      const p = await api<{ id: string }>(`/workspaces/${ws.id}/projects`, { body: { name, aspect, templateId: chosen.id, fieldValues: values } })
      router.push(`/projects/${p.id}`)
    } catch (err) {
      toast(errorMessage(err), 'danger')
      setBusy(false)
    }
  }
  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Modelos</h1>
          <p className="text-sm text-[var(--color-muted)]">Estruturas versionadas com cenas, campos, cores, legendas e regras de duração.</p>
        </div>
        <Select aria-label="Categoria" value={cat} onChange={(e) => setCat(e.target.value)} className="w-56">
          <option value="all">Todas as categorias</option>
          {Object.entries(CAT).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </header>
      {rows === null ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Empty title="Nenhum modelo nesta categoria" />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {shown.map((t) => {
            const d = t.definition
            const total = d.scenes.reduce((a, s) => a + s.duration, 0)
            return (
              <li key={t.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-3">
                <div className="flex items-start gap-2">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: d.colors.background, color: d.colors.accent }}>
                    <LayoutTemplate size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="font-medium truncate">{t.name}</h2>
                    <div className="flex gap-1 flex-wrap">
                      <Badge>{CAT[t.category] ?? t.category}</Badge>
                      <Badge tone="info">v{t.version}</Badge>
                      {!t.isSystem && <Badge tone="warn">Meu</Badge>}
                    </div>
                  </div>
                </div>
                <p className="text-[13px] text-[var(--color-muted)] line-clamp-3">{d.description}</p>
                <Storyboard def={d} />
                <div className="text-[12px] text-[var(--color-muted)]">
                  {d.scenes.length} cenas · ~{Math.round(total)} s (de {d.durationRules.minSeconds} a {d.durationRules.maxSeconds} s) · {d.aspects.join(', ')}
                </div>
                <div className="flex gap-2 mt-auto">
                  <Button variant="primary" className="flex-1" onClick={() => open(t)}>
                    Usar modelo
                  </Button>
                  <Button
                    icon={<Copy size={14} />}
                    aria-label={`Duplicar ${t.name}`}
                    onClick={async () => {
                      const slug = prompt('Identificador do novo modelo (letras minúsculas e hífens):', `${t.slug}-copia`)
                      if (!slug) return
                      try {
                        await api(`/templates/${t.id}/duplicate`, { body: { workspaceId: ws.id, slug, name: `${t.name} (cópia)` } })
                        toast('Modelo duplicado.', 'ok')
                        void load()
                      } catch (err) {
                        toast(errorMessage(err), 'danger')
                      }
                    }}
                  >
                    Duplicar
                  </Button>
                  {!t.isSystem && (
                    <Button
                      variant="danger"
                      icon={<Trash2 size={14} />}
                      aria-label={`Excluir ${t.name}`}
                      onClick={async () => {
                        if (!confirm('Excluir este modelo e todas as versões?')) return
                        await api(`/templates/${t.id}`, { method: 'DELETE' }).catch((e) => toast(errorMessage(e), 'danger'))
                        void load()
                      }}
                    >
                      Excluir
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <Dialog
        open={!!chosen}
        onClose={() => setChosen(null)}
        title={chosen ? `Novo projeto — ${chosen.name}` : ''}
        footer={
          <>
            <Button onClick={() => setChosen(null)}>Cancelar</Button>
            <Button variant="primary" loading={busy} onClick={create}>
              Criar projeto
            </Button>
          </>
        }
      >
        {chosen && (
          <div className="flex flex-col gap-3">
            <Field label="Nome do projeto" htmlFor="tn">
              <Input id="tn" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Formato" htmlFor="ta">
              <Select id="ta" value={aspect} onChange={(e) => setAspect(e.target.value)}>
                {chosen.definition.aspects.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </Select>
            </Field>
            {chosen.definition.fields
              .filter((f) => f.type === 'text')
              .map((f) => (
                <Field key={f.key} label={f.label} htmlFor={`f-${f.key}`} hint={f.maxLength ? `Até ${f.maxLength} caracteres` : undefined}>
                  <TextArea id={`f-${f.key}`} className="min-h-[44px]" maxLength={f.maxLength} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                </Field>
              ))}
            <p className="text-[12px] text-[var(--color-muted)]">Campos de mídia viram espaços reservados na linha do tempo para você substituir depois.</p>
          </div>
        )}
      </Dialog>
    </div>
  )
}
