'use client'
import type { TimelineDoc } from '@orion/shared'
import { Badge, Button, Dialog, Field, Input, ProgressBar, Select, formatBytes, useToast } from '@orion/ui'
import { Download, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage, newKey } from '@/lib/api'
import type { RenderDto } from '@/lib/types'
import { useEditor } from './store'

const STATUS: Record<RenderDto['status'], { label: string; tone: 'neutral' | 'ok' | 'danger' | 'warn' | 'info' }> = {
  queued: { label: 'Na fila', tone: 'neutral' },
  running: { label: 'Processando', tone: 'info' },
  succeeded: { label: 'Concluído', tone: 'ok' },
  failed: { label: 'Falhou', tone: 'danger' },
  canceled: { label: 'Cancelado', tone: 'warn' },
}

export function ExportDialog({ open, onClose, flush }: { open: boolean; onClose: () => void; flush: () => Promise<boolean> }) {
  const { projectId } = useEditor()
  const toast = useToast()
  const [resolution, setResolution] = useState<'720p' | '1080p' | '2160p'>('1080p')
  const [captions, setCaptions] = useState<'none' | 'burn' | 'sidecar' | 'both'>('burn')
  const [loudness, setLoudness] = useState(true)
  const [current, setCurrent] = useState<RenderDto | null>(null)
  const [history, setHistory] = useState<RenderDto[]>([])
  const [issues, setIssues] = useState<Array<{ message: string; severity: string }>>([])
  const key = useRef(newKey())
  useEffect(() => {
    if (!open) return
    key.current = newKey()
    api<RenderDto[]>(`/projects/${projectId}/renders`).then(setHistory).catch(() => undefined)
  }, [open, projectId])
  useEffect(() => {
    if (!current || current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled') return
    const id = setInterval(async () => {
      try {
        const r = await api<RenderDto>(`/renders/${current.id}`)
        setCurrent(r)
        if (r.status === 'succeeded') toast('Exportação concluída e validada.', 'ok')
        if (r.status === 'failed') toast('A exportação falhou. Veja os detalhes.', 'danger')
      } catch {
        // tenta de novo no próximo ciclo
      }
    }, 1500)
    return () => clearInterval(id)
  }, [current, toast])
  async function start() {
    setIssues([])
    if (!(await flush())) return toast('Salve o projeto antes de exportar (há um conflito ou erro de salvamento).', 'danger')
    try {
      const r = await api<RenderDto>(`/projects/${projectId}/renders`, { body: { preset: { resolution, captions, normalizeLoudness: loudness }, idempotencyKey: key.current } })
      setCurrent(r)
    } catch (err) {
      const det = (err as { details?: unknown }).details
      if (Array.isArray(det)) setIssues(det as typeof issues)
      toast(errorMessage(err), 'danger')
    }
  }
  const running = current && (current.status === 'queued' || current.status === 'running')
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Exportar vídeo"
      wide
      footer={
        <>
          {running && (
            <Button variant="danger" onClick={async () => setCurrent(await api<RenderDto>(`/renders/${current!.id}/cancel`, { body: {} }))}>
              Cancelar exportação
            </Button>
          )}
          <Button onClick={onClose}>Fechar</Button>
          <Button variant="primary" onClick={start} disabled={!!running}>
            Iniciar exportação
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="flex flex-col gap-3 text-sm">
          <Field
            label="Resolução"
            htmlFor="res"
            hint={resolution === '2160p' ? '4K: medido a ~0,6× o tempo real em 4 vCPU (≈ 5× mais lento que 720p), pico de 1,6 GB de memória e ~58 MB por minuto. Mídias abaixo de 4K são ampliadas.' : 'MP4 H.264 + AAC.'}
          >
            <Select id="res" value={resolution} onChange={(e) => setResolution(e.target.value as '720p' | '1080p' | '2160p')}>
              <option value="1080p">1080p (Full HD)</option>
              <option value="720p">720p (HD)</option>
              <option value="2160p">2160p (4K)</option>
            </Select>
          </Field>
          <Field label="Legendas" htmlFor="cap">
            <Select id="cap" value={captions} onChange={(e) => setCaptions(e.target.value as typeof captions)}>
              <option value="burn">Gravadas no vídeo</option>
              <option value="sidecar">Arquivos SRT/VTT separados</option>
              <option value="both">Gravadas + arquivos</option>
              <option value="none">Sem legendas</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={loudness} onChange={(e) => setLoudness(e.target.checked)} /> Normalizar volume (−14 LUFS, redes sociais)
          </label>
          <p className="text-[12px] text-[var(--color-muted)]">A exportação usa uma cópia imutável do projeto: você pode continuar editando enquanto ela roda.</p>
          {issues.length > 0 && (
            <ul className="text-[12px] text-[var(--color-danger)] list-disc pl-4" role="alert">
              {issues.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          )}
          {current && (
            <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Badge tone={STATUS[current.status].tone}>{STATUS[current.status].label}</Badge>
                <span className="text-[12px] text-[var(--color-muted)]">{current.stage}</span>
              </div>
              {running && <ProgressBar value={current.progress} label="Progresso" />}
              {current.error && <pre className="text-[11px] whitespace-pre-wrap text-[var(--color-danger)] max-h-32 overflow-auto">{current.error}</pre>}
              {current.status === 'succeeded' && current.downloadUrl && (
                <>
                  <video src={current.previewUrl} controls className="w-full max-h-64 rounded bg-black" aria-label="Vídeo exportado" />
                  <div className="flex flex-wrap gap-2">
                    <a href={current.downloadUrl}>
                      <Button variant="primary" icon={<Download size={14} />}>
                        Baixar MP4
                      </Button>
                    </a>
                    {current.srtUrl && (
                      <a href={current.srtUrl}>
                        <Button icon={<Download size={14} />}>SRT</Button>
                      </a>
                    )}
                    {current.vttUrl && (
                      <a href={current.vttUrl}>
                        <Button icon={<Download size={14} />}>VTT</Button>
                      </a>
                    )}
                  </div>
                  {current.validation && (
                    <table className="text-[11px] w-full">
                      <caption className="text-left text-[var(--color-muted)] mb-1">Validação do arquivo final ({formatBytes(current.validation.sizeBytes)})</caption>
                      <tbody>
                        {current.validation.checks.map((c) => (
                          <tr key={c.name}>
                            <td>{c.ok ? '✓' : '✗'}</td>
                            <td>{c.name}</td>
                            <td className="text-[var(--color-muted)]">{c.actual}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">Exportações anteriores</h3>
          {history.length === 0 && <p className="text-[12px] text-[var(--color-muted)]">Nenhuma ainda.</p>}
          <ul className="flex flex-col gap-1.5 max-h-80 overflow-auto">
            {history.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-[12px] rounded border border-[var(--color-border)] p-2">
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                <span>{r.preset.resolution}</span>
                <span className="text-[var(--color-muted)]">{new Date(r.createdAt).toLocaleString('pt-BR')}</span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={async () => setCurrent(await api<RenderDto>(`/renders/${r.id}`))}>
                  Ver
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  )
}

export function VersionsDialog({ open, onClose, flush }: { open: boolean; onClose: () => void; flush: () => Promise<boolean> }) {
  const { projectId, replaceDoc } = useEditor()
  const toast = useToast()
  const [revs, setRevs] = useState<Array<{ id: string; number: number; reason: string; createdAt: string }>>([])
  const [reason, setReason] = useState('')
  const load = () => api<typeof revs>(`/projects/${projectId}/revisions`).then(setRevs).catch((e) => toast(errorMessage(e), 'danger'))
  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <Dialog open={open} onClose={onClose} title="Histórico de versões">
      <div className="flex flex-col gap-3 text-sm">
        <form
          className="flex gap-2 items-end"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!(await flush())) return
            await api(`/projects/${projectId}/revisions`, { body: { reason: reason || 'Versão manual' } })
            setReason('')
            void load()
          }}
        >
          <div className="flex-1">
            <Field label="Nomear versão atual" htmlFor="rv">
              <Input id="rv" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: corte aprovado pelo cliente" />
            </Field>
          </div>
          <Button type="submit">Salvar versão</Button>
        </form>
        <ul className="flex flex-col gap-1.5">
          {revs.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded border border-[var(--color-border)] p-2 text-[13px]">
              <span className="tabular-nums text-[var(--color-muted)]">v{r.number}</span>
              <span className="flex-1 truncate">{r.reason}</span>
              <span className="text-[11px] text-[var(--color-muted)]">{new Date(r.createdAt).toLocaleString('pt-BR')}</span>
              <Button
                size="sm"
                icon={<RotateCcw size={12} />}
                onClick={async () => {
                  if (!confirm(`Restaurar a versão v${r.number}? A versão atual é guardada antes.`)) return
                  try {
                    if (!(await flush())) return
                    const res = await api<{ docVersion: number; document: TimelineDoc }>(`/projects/${projectId}/revisions/${r.id}/restore`, { body: {} })
                    replaceDoc(res.document, res.docVersion)
                    toast(`Versão v${r.number} restaurada.`, 'ok')
                    onClose()
                  } catch (err) {
                    toast(errorMessage(err), 'danger')
                  }
                }}
              >
                Restaurar
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}
