'use client'
import { formatClock } from '@orion/timeline'
import { Badge, Button, Dialog, Field, Input, Select, Spinner, useToast } from '@orion/ui'
import { Pause, Play, Star, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { MusicDto } from '@/lib/types'
import { uploadFile, waitForAsset } from '@/lib/upload'

export default function MusicPage() {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const [items, setItems] = useState<MusicDto[] | null>(null)
  const [f, setF] = useState({ q: '', mood: '', minSeconds: '', maxSeconds: '', minBpm: '', maxBpm: '', sfx: 'false', favorites: 'false' })
  const [playing, setPlaying] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)
  const load = useCallback(() => {
    // filtros vazios não vão para a query; sfx é sempre enviado
    const qs = new URLSearchParams(Object.entries(f).filter(([k, v]) => v !== '' && !(k === 'favorites' && v === 'false')))
    api<MusicDto[]>(`/workspaces/${ws.id}/music?${qs}`).then(setItems).catch((e) => toast(errorMessage(e), 'danger'))
  }, [f, ws.id, toast])
  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])
  useEffect(() => () => audio.current?.pause(), [])
  const moods = [...new Set((items ?? []).map((m) => m.mood))]
  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-5">
      <header className="flex flex-wrap justify-between items-end gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Biblioteca musical</h1>
          <p className="text-sm text-[var(--color-muted)]">Somente faixas com licença registrada (origem, autor, uso comercial, atribuição e restrições).</p>
        </div>
        <Button icon={<Upload size={16} />} onClick={() => setUploadOpen(true)}>
          Enviar música própria
        </Button>
      </header>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 items-end">
        <div className="col-span-2">
          <Field label="Buscar" htmlFor="mq">
            <Input id="mq" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Nome, artista, gênero" />
          </Field>
        </div>
        <Field label="Clima" htmlFor="mm">
          <Select id="mm" value={f.mood} onChange={(e) => setF({ ...f, mood: e.target.value })}>
            <option value="">Todos</option>
            {moods.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field label="Duração mín. (s)" htmlFor="d1">
          <Input id="d1" type="number" min={0} value={f.minSeconds} onChange={(e) => setF({ ...f, minSeconds: e.target.value })} />
        </Field>
        <Field label="Duração máx. (s)" htmlFor="d2">
          <Input id="d2" type="number" min={0} value={f.maxSeconds} onChange={(e) => setF({ ...f, maxSeconds: e.target.value })} />
        </Field>
        <Field label="BPM mín." htmlFor="b1">
          <Input id="b1" type="number" min={0} value={f.minBpm} onChange={(e) => setF({ ...f, minBpm: e.target.value })} />
        </Field>
        <Field label="Tipo" htmlFor="ty">
          <Select id="ty" value={f.sfx} onChange={(e) => setF({ ...f, sfx: e.target.value })}>
            <option value="false">Músicas</option>
            <option value="true">Efeitos sonoros</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm h-9">
          <input type="checkbox" checked={f.favorites === 'true'} onChange={(e) => setF({ ...f, favorites: String(e.target.checked) })} /> Favoritas
        </label>
      </div>
      {items === null ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface)] text-left text-[12px] text-[var(--color-muted)]">
              <tr>
                <th className="p-3">Faixa</th>
                <th className="p-3">Clima / gênero</th>
                <th className="p-3">Duração</th>
                <th className="p-3">BPM</th>
                <th className="p-3">Licença</th>
                <th className="p-3"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-t border-[var(--color-border)]">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <button
                        aria-label={playing === m.id ? `Pausar ${m.title}` : `Ouvir ${m.title}`}
                        className="w-8 h-8 rounded-full bg-[var(--color-surface-2)] flex items-center justify-center"
                        onClick={() => {
                          audio.current?.pause()
                          if (playing === m.id) return setPlaying(null)
                          audio.current = new Audio(m.url)
                          audio.current.onended = () => setPlaying(null)
                          void audio.current.play()
                          setPlaying(m.id)
                        }}
                      >
                        {playing === m.id ? <Pause size={14} /> : <Play size={14} />}
                      </button>
                      <div>
                        <div className="font-medium">{m.title}</div>
                        <div className="text-[12px] text-[var(--color-muted)]">{m.artist}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 text-[13px]">{m.mood} · {m.genre}</td>
                  <td className="p-3 tabular-nums">{formatClock(m.durationFlicks)}</td>
                  <td className="p-3 tabular-nums">{m.bpm ?? '—'}</td>
                  <td className="p-3">
                    <div className="flex flex-col gap-1 text-[11px]">
                      <span className="flex gap-1 flex-wrap">
                        <Badge tone={m.license.commercialUse ? 'ok' : 'danger'}>{m.license.licenseName}</Badge>
                        <Badge tone={m.license.commercialUse ? 'ok' : 'danger'}>{m.license.commercialUse ? 'Uso comercial' : 'Sem uso comercial'}</Badge>
                        {m.license.attributionRequired && <Badge tone="warn">Atribuição obrigatória</Badge>}
                      </span>
                      <span className="text-[var(--color-muted)]">Origem: {m.license.source} · Autor: {m.license.author}</span>
                      {m.license.platformRestrictions && <span className="text-[var(--color-muted)]">Restrições: {m.license.platformRestrictions}</span>}
                      {m.license.validUntil && <span className="text-[var(--color-muted)]">Válida até {new Date(m.license.validUntil).toLocaleDateString('pt-BR')}</span>}
                    </div>
                  </td>
                  <td className="p-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-pressed={m.favorite}
                      icon={<Star size={14} fill={m.favorite ? 'currentColor' : 'none'} className={m.favorite ? 'text-[var(--color-accent)]' : ''} />}
                      onClick={async () => {
                        await api(`/music/${m.id}/favorite`, { method: m.favorite ? 'DELETE' : 'POST', ...(m.favorite ? {} : { body: {} }) })
                        load()
                      }}
                    >
                      {m.favorite ? 'Favorita' : 'Favoritar'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <UploadMusicDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onDone={load} />
    </div>
  )
}

function UploadMusicDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [meta, setMeta] = useState({ title: '', artist: '', genre: '', mood: '', bpm: '', licenseName: '', commercialUse: true, attributionRequired: false, attributionText: '', platformRestrictions: '', declaration: false, isSfx: false })
  const [progress, setProgress] = useState<number | null>(null)
  async function submit() {
    if (!file || !meta.declaration) return
    try {
      setProgress(0)
      const id = await uploadFile(ws.id, file, setProgress)
      await waitForAsset(id)
      await api(`/workspaces/${ws.id}/music`, {
        body: { assetId: id, title: meta.title || file.name, artist: meta.artist, genre: meta.genre || 'outro', mood: meta.mood || 'neutro', bpm: meta.bpm ? Number(meta.bpm) : undefined, isSfx: meta.isSfx, license: { licenseName: meta.licenseName, commercialUse: meta.commercialUse, attributionRequired: meta.attributionRequired, attributionText: meta.attributionText || undefined, platformRestrictions: meta.platformRestrictions || undefined, declaration: true } },
      })
      toast('Música registrada com a licença informada.', 'ok')
      onDone()
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'danger')
    } finally {
      setProgress(null)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Enviar música própria" footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={!file || !meta.declaration || meta.licenseName.length < 2} loading={progress !== null} onClick={submit}>Enviar</Button></>}>
      <div className="flex flex-col gap-3 text-sm">
        <Field label="Arquivo de áudio" htmlFor="mf">
          <input id="mf" type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Título" htmlFor="mt"><Input id="mt" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} /></Field>
          <Field label="Autor" htmlFor="ma"><Input id="ma" value={meta.artist} onChange={(e) => setMeta({ ...meta, artist: e.target.value })} /></Field>
          <Field label="Gênero" htmlFor="mg"><Input id="mg" value={meta.genre} onChange={(e) => setMeta({ ...meta, genre: e.target.value })} /></Field>
          <Field label="Clima" htmlFor="mo"><Input id="mo" value={meta.mood} onChange={(e) => setMeta({ ...meta, mood: e.target.value })} /></Field>
          <Field label="BPM (opcional)" htmlFor="mb"><Input id="mb" type="number" value={meta.bpm} onChange={(e) => setMeta({ ...meta, bpm: e.target.value })} /></Field>
          <Field label="Licença" htmlFor="ml"><Input id="ml" placeholder="Ex.: Licença comercial XYZ" value={meta.licenseName} onChange={(e) => setMeta({ ...meta, licenseName: e.target.value })} /></Field>
        </div>
        <label className="flex gap-2"><input type="checkbox" checked={meta.commercialUse} onChange={(e) => setMeta({ ...meta, commercialUse: e.target.checked })} /> Uso comercial permitido</label>
        <label className="flex gap-2"><input type="checkbox" checked={meta.attributionRequired} onChange={(e) => setMeta({ ...meta, attributionRequired: e.target.checked })} /> Exige atribuição</label>
        {meta.attributionRequired && <Field label="Texto de atribuição" htmlFor="mat"><Input id="mat" value={meta.attributionText} onChange={(e) => setMeta({ ...meta, attributionText: e.target.value })} /></Field>}
        <Field label="Restrições de plataforma (opcional)" htmlFor="mr"><Input id="mr" value={meta.platformRestrictions} onChange={(e) => setMeta({ ...meta, platformRestrictions: e.target.value })} /></Field>
        <label className="flex gap-2"><input type="checkbox" checked={meta.isSfx} onChange={(e) => setMeta({ ...meta, isSfx: e.target.checked })} /> É efeito sonoro</label>
        <label className="flex gap-2 items-start rounded-lg border border-[var(--color-accent)]/40 p-2">
          <input type="checkbox" checked={meta.declaration} onChange={(e) => setMeta({ ...meta, declaration: e.target.checked })} className="mt-1" />
          Declaro possuir os direitos de sincronização desta obra para uso em vídeo, conforme a licença informada. Acesso a streaming não concede esse direito.
        </label>
        {progress !== null && <p className="text-[12px]">Enviando… {Math.round(progress * 100)}%</p>}
      </div>
    </Dialog>
  )
}
