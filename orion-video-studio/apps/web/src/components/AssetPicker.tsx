'use client'
import { Button, ProgressBar, Select, useToast } from '@orion/ui'
import { Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { AssetDto } from '@/lib/types'
import { uploadFile, waitForAsset } from '@/lib/upload'

/** Seleciona uma mídia do workspace (ou envia uma nova) com prévia. */
export function AssetPicker({ label, value, onChange, kinds, id }: { label: string; value: string | null | undefined; onChange: (id: string | null) => void; kinds: Array<'IMAGE' | 'VIDEO' | 'AUDIO'>; id: string }) {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const [assets, setAssets] = useState<AssetDto[]>([])
  const [progress, setProgress] = useState<number | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    api<AssetDto[]>(`/workspaces/${ws.id}/assets`).then((l) => setAssets(l.filter((a) => kinds.includes(a.kind as never) && a.status === 'READY'))).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id])
  const current = assets.find((a) => a.id === value)
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-medium text-[var(--color-muted)]">{label}</label>
      <div className="flex gap-2 items-center">
        {current?.thumbnailUrl && <img src={current.thumbnailUrl} alt="" className="w-10 h-10 rounded object-cover" />}
        <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Nenhum</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.originalName}</option>)}
        </Select>
        <Button size="sm" icon={<Upload size={12} />} onClick={() => ref.current?.click()} aria-label={`Enviar arquivo para ${label}`}>Enviar</Button>
        <input
          ref={ref}
          type="file"
          hidden
          accept={kinds.map((k) => (k === 'IMAGE' ? 'image/png,image/jpeg,image/webp' : k === 'VIDEO' ? 'video/*' : 'audio/*')).join(',')}
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            try {
              setProgress(0)
              const aid = await uploadFile(ws.id, f, setProgress)
              const a = await waitForAsset(aid)
              setAssets((l) => [a, ...l])
              onChange(a.id)
            } catch (err) {
              toast(errorMessage(err), 'danger')
            } finally {
              setProgress(null)
            }
          }}
        />
      </div>
      {progress !== null && <ProgressBar value={progress} label="Enviando" />}
    </div>
  )
}
