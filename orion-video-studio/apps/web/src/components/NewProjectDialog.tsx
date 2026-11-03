'use client'
import type { AspectPreset } from '@orion/shared'
import { SUPPORTED_FPS } from '@orion/timeline'
import { Button, Dialog, Field, Input, Select, useToast } from '@orion/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useSession, useT } from '@/lib/session'

export const ASPECTS: Array<{ id: AspectPreset; label: string; hint: string; w: number; h: number }> = [
  { id: '9:16', label: '9:16 Vertical', hint: 'Reels, TikTok, Shorts', w: 9, h: 16 },
  { id: '16:9', label: '16:9 Horizontal', hint: 'YouTube, apresentações', w: 16, h: 9 },
  { id: '1:1', label: '1:1 Quadrado', hint: 'Feed', w: 1, h: 1 },
  { id: '4:5', label: '4:5 Retrato', hint: 'Feed do Instagram', w: 4, h: 5 },
  { id: 'custom', label: 'Personalizado', hint: 'Até 3840 px', w: 4, h: 3 },
]

export function NewProjectDialog({ open, onClose, templateId, defaultName }: { open: boolean; onClose: () => void; templateId?: string; defaultName?: string }) {
  const t = useT()
  const router = useRouter()
  const toast = useToast()
  const ws = useSession((s) => s.workspace)!
  const [name, setName] = useState(defaultName ?? 'Novo vídeo')
  const [aspect, setAspect] = useState<AspectPreset>('9:16')
  const [width, setWidth] = useState(1080)
  const [height, setHeight] = useState(1920)
  const [fps, setFps] = useState('30/1')
  const [busy, setBusy] = useState(false)
  async function create() {
    setBusy(true)
    try {
      const [num, den] = fps.split('/').map(Number)
      const body: Record<string, unknown> = { name, aspect, fps: { num, den }, ...(templateId ? { templateId } : {}) }
      if (aspect === 'custom') Object.assign(body, { width: Math.round(width / 2) * 2, height: Math.round(height / 2) * 2 })
      const p = await api<{ id: string }>(`/workspaces/${ws.id}/projects`, { body })
      router.push(`/projects/${p.id}`)
    } catch (err) {
      toast(errorMessage(err), 'danger')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('projects.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={create}>
            {t('projects.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('projects.name')} htmlFor="pname">
          <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <fieldset>
          <legend className="text-[12px] font-medium text-[var(--color-muted)] mb-2">{t('projects.format')}</legend>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-pressed={aspect === a.id}
                onClick={() => setAspect(a.id)}
                className={`flex items-center gap-3 rounded-lg border p-2.5 text-left ${aspect === a.id ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}
              >
                <span className="shrink-0 border-2 border-current rounded-sm text-[var(--color-muted)]" style={{ width: (a.w / Math.max(a.w, a.h)) * 28, height: (a.h / Math.max(a.w, a.h)) * 28 }} aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium">{a.label}</span>
                  <span className="block text-[11px] text-[var(--color-muted)]">{a.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </fieldset>
        {aspect === 'custom' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Largura (px)" htmlFor="w" hint="Par, 144–3840">
              <Input id="w" type="number" min={144} max={3840} step={2} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
            </Field>
            <Field label="Altura (px)" htmlFor="h" hint="Par, 144–3840">
              <Input id="h" type="number" min={144} max={3840} step={2} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
            </Field>
          </div>
        )}
        <Field label="Quadros por segundo" htmlFor="fps">
          <Select id="fps" value={fps} onChange={(e) => setFps(e.target.value)}>
            {SUPPORTED_FPS.map((f) => (
              <option key={`${f.num}/${f.den}`} value={`${f.num}/${f.den}`}>
                {f.label} fps
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  )
}

