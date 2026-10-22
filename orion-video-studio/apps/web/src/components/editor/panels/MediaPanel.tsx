'use client'
import type { Clip } from '@orion/shared'
import { FLICKS_PER_SECOND, TRACK_ACCEPTS, addClip, clipEnd, deleteClips, findClip, findFreeSlot, formatClock, makeMediaClip, quantize, splitClip } from '@orion/timeline'
import { Badge, Button, Empty, ProgressBar, Select, Spinner, formatBytes, useToast } from '@orion/ui'
import { AudioLines, Film, Image as ImageIcon, Mic, Scissors, Square, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { AssetDto } from '@/lib/types'
import { uploadFile, waitForAsset } from '@/lib/upload'
import { ASSET_MIME, type DraggedAsset } from '../Timeline'
import { useDoc, useEditor } from '../store'

export function useAddAssetToTimeline() {
  const doc = useDoc()
  const { apply, playhead, select } = useEditor()
  return (a: AssetDto, preferKind?: 'voice' | 'music' | 'audio' | 'overlay') => {
    const type = a.kind === 'VIDEO' ? 'video' : a.kind === 'IMAGE' ? 'image' : 'audio'
    const track =
      (preferKind && doc.tracks.find((t) => t.kind === preferKind && !t.locked && TRACK_ACCEPTS[t.kind].includes(type))) ??
      doc.tracks.find((t) => !t.locked && TRACK_ACCEPTS[t.kind].includes(type) && (type === 'audio' ? t.kind === 'audio' : t.kind === 'video'))
    if (!track) return
    const dur = quantize(a.durationFlicks ?? 5 * FLICKS_PER_SECOND, doc.settings.fps, 'floor')
    const at = findFreeSlot(track, quantize(playhead, doc.settings.fps), dur)
    const clip = makeMediaClip(type, a.id, at, dur, a.originalName.replace(/\.[^.]+$/, ''))
    if (apply((d) => addClip(d, track.id, clip))) select([clip.id])
  }
}

export function MediaPanel() {
  const { workspaceId, assets, setAssets, upsertAsset, selection } = useEditor()
  const doc = useDoc()
  const toast = useToast()
  const add = useAddAssetToTimeline()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploads, setUploads] = useState<Array<{ name: string; progress: number; stage: string }>>([])
  const [filter, setFilter] = useState<'ALL' | 'VIDEO' | 'AUDIO' | 'IMAGE'>('ALL')
  const [dragOver, setDragOver] = useState(false)

  const loading = Object.keys(assets).length === 0 && !useEditor.getState().assetsLoaded

  async function handleFiles(files: FileList | File[], source: 'UPLOAD' | 'RECORDING' = 'UPLOAD') {
    for (const f of Array.from(files)) {
      const name = f.name
      setUploads((u) => [...u, { name, progress: 0, stage: 'Enviando' }])
      try {
        const id = await uploadFile(workspaceId, f, (p) => setUploads((u) => u.map((x) => (x.name === name ? { ...x, progress: p } : x))), source)
        setUploads((u) => u.map((x) => (x.name === name ? { ...x, stage: 'Processando (miniatura, forma de onda, proxy)' } : x)))
        const a = await waitForAsset(id)
        upsertAsset(a)
        toast(`"${name}" pronto.`, 'ok')
      } catch (err) {
        toast(`${name}: ${errorMessage(err)}`, 'danger')
      } finally {
        setUploads((u) => u.filter((x) => x.name !== name))
      }
    }
  }

  const list = Object.values(assets)
    .filter((a) => a.source !== 'CATALOG' && a.source !== 'RENDER' && a.kind !== 'SUBTITLE')
    .filter((a) => filter === 'ALL' || a.kind === filter)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const selectedClip = selection.length === 1 ? findClip(doc, selection[0]!) : null

  return (
    <div
      className={`flex flex-col gap-3 p-3 min-h-full ${dragOver ? 'outline-2 outline-dashed outline-[var(--color-accent)] -outline-offset-4' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragOver(false)
        void handleFiles(e.dataTransfer.files)
      }}
    >
      <div className="flex gap-2 flex-wrap">
        <Button variant="primary" icon={<Upload size={16} />} onClick={() => fileRef.current?.click()}>
          Enviar arquivos
        </Button>
        <Recorder onDone={(f) => handleFiles([f], 'RECORDING')} />
        <input ref={fileRef} type="file" multiple hidden accept="video/*,audio/*,image/png,image/jpeg,image/webp" onChange={(e) => e.target.files && handleFiles(e.target.files)} aria-label="Selecionar arquivos" />
      </div>
      <p className="text-[12px] text-[var(--color-muted)]">Arraste arquivos para cá. Arquivos grandes são enviados em partes direto ao armazenamento. Arraste da lista para a timeline.</p>
      {uploads.map((u) => (
        <ProgressBar key={u.name} value={u.progress} label={`${u.stage}: ${u.name}`} />
      ))}
      <Select aria-label="Filtrar mídia" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
        <option value="ALL">Todos os tipos</option>
        <option value="VIDEO">Vídeos</option>
        <option value="AUDIO">Áudios</option>
        <option value="IMAGE">Imagens</option>
      </Select>
      {loading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title="Biblioteca vazia">Envie vídeos, áudios ou imagens para começar.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((a) => (
            <li
              key={a.id}
              draggable={a.status === 'READY'}
              onDragStart={(e) => {
                const payload: DraggedAsset = { assetId: a.id, kind: a.kind as DraggedAsset['kind'], durationFlicks: a.durationFlicks, name: a.originalName.replace(/\.[^.]+$/, '') }
                e.dataTransfer.setData(ASSET_MIME, JSON.stringify(payload))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className="flex gap-2 items-center rounded-lg border border-[var(--color-border)] p-2 bg-[var(--color-bg)]"
            >
              <div className="w-16 h-10 shrink-0 rounded bg-[var(--color-surface-2)] bg-cover bg-center flex items-center justify-center text-[var(--color-faint)]" style={a.thumbnailUrl ? { backgroundImage: `url(${a.thumbnailUrl})` } : undefined}>
                {!a.thumbnailUrl && (a.kind === 'AUDIO' ? <AudioLines size={18} /> : a.kind === 'IMAGE' ? <ImageIcon size={18} /> : <Film size={18} />)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] truncate" title={a.originalName}>
                  {a.originalName}
                </div>
                <div className="flex gap-1 flex-wrap text-[11px] text-[var(--color-muted)] items-center">
                  {a.status !== 'READY' ? <Badge tone={a.status === 'FAILED' ? 'danger' : 'warn'}>{a.status === 'FAILED' ? `Falhou: ${a.error ?? ''}` : 'Processando'}</Badge> : null}
                  {a.durationFlicks ? <span>{formatClock(a.durationFlicks)}</span> : null}
                  <span>{formatBytes(a.sizeBytes)}</span>
                  {a.source === 'GENERATED' && <Badge tone="info">IA</Badge>}
                  {a.source === 'TTS' && <Badge tone="info">Voz</Badge>}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Button size="sm" disabled={a.status !== 'READY'} onClick={() => add(a)}>
                  Adicionar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  aria-label={`Excluir ${a.originalName}`}
                  onClick={async () => {
                    if (!confirm('Excluir esta mídia? Ela precisa estar fora de todos os projetos.')) return
                    try {
                      await api(`/assets/${a.id}`, { method: 'DELETE' })
                      const next = { ...useEditor.getState().assets }
                      delete next[a.id]
                      setAssets(Object.values(next))
                    } catch (err) {
                      toast(errorMessage(err), 'danger')
                    }
                  }}
                >
                  Excluir
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {selectedClip && 'assetId' in selectedClip.clip && assets[selectedClip.clip.assetId]?.hasAudio && <SilenceTool clipId={selectedClip.clip.id} />}
    </div>
  )
}

/** Detecta silêncio no áudio do clipe selecionado e sugere cortes (com prévia e desfazer). */
function SilenceTool({ clipId }: { clipId: string }) {
  const doc = useDoc()
  const { apply } = useEditor()
  const toast = useToast()
  const found = findClip(doc, clipId)
  const [result, setResult] = useState<Array<{ start: number; end: number }> | null>(null)
  const [busy, setBusy] = useState(false)
  if (!found || !('assetId' in found.clip) || found.clip.type === 'image') return null
  const clip = found.clip
  // converte intervalos da mídia em intervalos da timeline dentro do clipe
  const toTimeline = (r: { start: number; end: number }) => {
    const a = clip.start + Math.round((r.start - clip.sourceIn) / clip.speed)
    const b = clip.start + Math.round((r.end - clip.sourceIn) / clip.speed)
    return { start: Math.max(clip.start, quantize(a, doc.settings.fps, 'ceil')), end: Math.min(clipEnd(clip), quantize(b, doc.settings.fps, 'floor')) }
  }
  const inClip = (result ?? []).map(toTimeline).filter((r) => r.end - r.start > FLICKS_PER_SECOND / 5)
  async function detect() {
    setBusy(true)
    try {
      const { requestId } = await api<{ requestId: string }>(`/assets/${clip.assetId}/silence`, { body: { noiseDb: -35, minSeconds: 0.6 } })
      for (;;) {
        const r = await api<{ status: string; intervals?: Array<{ start: number; end: number }>; error?: string }>(`/silence/${requestId}`)
        if (r.status === 'succeeded') {
          setResult(r.intervals ?? [])
          break
        }
        if (r.status === 'failed') throw new Error(r.error ?? 'Falha na análise')
        await new Promise((res) => setTimeout(res, 1000))
      }
    } catch (err) {
      toast(errorMessage(err), 'danger')
    } finally {
      setBusy(false)
    }
  }
  function cutAll() {
    apply((d) => {
      let cur = d
      // do fim para o início: cada corte fecha o espaço (ripple)
      for (const r of [...inClip].sort((a, b) => b.start - a.start)) {
        const target = cur.tracks.flatMap((t) => t.clips).find((c) => c.start <= r.start && clipEnd(c) >= r.end && ('assetId' in c ? c.assetId === clip.assetId : false))
        if (!target) continue
        let work = cur
        let midId = target.id
        if (r.start > target.start) {
          work = splitClip(work, target.id, r.start)
          midId = work.tracks.flatMap((t) => t.clips).find((c) => c.start === r.start && 'assetId' in c && c.assetId === clip.assetId)!.id
        }
        const mid = work.tracks.flatMap((t) => t.clips).find((c) => c.id === midId)!
        if (r.end < clipEnd(mid)) work = splitClip(work, midId, r.end)
        cur = deleteClips(work, [midId], true)
      }
      return cur
    })
    setResult(null)
    toast('Silêncios removidos. Use Desfazer para reverter.', 'ok')
  }
  return (
    <section className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2">
      <h3 className="text-[13px] font-medium flex items-center gap-1">
        <Scissors size={14} /> Silêncios em “{clip.name}”
      </h3>
      {result === null ? (
        <Button size="sm" loading={busy} onClick={detect}>
          Detectar silêncio
        </Button>
      ) : inClip.length === 0 ? (
        <p className="text-[12px] text-[var(--color-muted)]">Nenhum silêncio acima de 0,6 s dentro do clipe.</p>
      ) : (
        <>
          <ul className="text-[12px] text-[var(--color-muted)] max-h-28 overflow-auto">
            {inClip.map((r, i) => (
              <li key={i}>
                {formatClock(r.start)} → {formatClock(r.end)}
              </li>
            ))}
          </ul>
          <Button size="sm" variant="primary" onClick={cutAll}>
            Cortar {inClip.length} trecho(s) e fechar espaços
          </Button>
        </>
      )}
    </section>
  )
}

function Recorder({ onDone }: { onDone: (f: File) => void }) {
  const toast = useToast()
  const [rec, setRec] = useState<MediaRecorder | null>(null)
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!rec) return
    const id = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [rec])
  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const r = new MediaRecorder(stream, { mimeType: mime })
      const chunks: Blob[] = []
      r.ondataavailable = (e) => chunks.push(e.data)
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunks, { type: mime })
        onDone(new File([blob], `narracao-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${mime === 'audio/webm' ? 'webm' : 'm4a'}`, { type: mime }))
      }
      r.start(1000)
      setSecs(0)
      setRec(r)
    } catch {
      toast('Não foi possível acessar o microfone. Verifique a permissão do navegador.', 'danger')
    }
  }
  return rec ? (
    <Button
      variant="danger"
      icon={<Square size={14} />}
      onClick={() => {
        rec.stop()
        setRec(null)
      }}
    >
      Parar gravação ({secs}s)
    </Button>
  ) : (
    <Button icon={<Mic size={16} />} onClick={start}>
      Gravar narração
    </Button>
  )
}
