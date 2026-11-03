'use client'
import { addClip, docDuration, executeCommand, findFreeSlot, formatClock, makeMediaClip, makeTextClip, quantize, secondsToFlicks } from '@orion/timeline'
import { Badge, Button, Input, Select, Spinner, useToast } from '@orion/ui'
import { Pause, Play, Plus, Repeat, Star, Type } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { MusicDto } from '@/lib/types'
import { useDoc, useEditor } from '../store'

const TEXT_PRESETS = [
  { label: 'Título', text: 'Seu título aqui', fontSize: 110, fontWeight: 800 as const, y: 0.4, animation: 'pop' as const, background: null },
  { label: 'Subtítulo', text: 'Um subtítulo de apoio', fontSize: 64, fontWeight: 600 as const, y: 0.5, animation: 'fade' as const, background: null },
  { label: 'Destaque com fundo', text: 'DESTAQUE', fontSize: 72, fontWeight: 800 as const, y: 0.3, animation: 'slide-up' as const, background: '#F2A93B' },
  { label: 'Chamada para ação', text: 'Siga para mais', fontSize: 70, fontWeight: 800 as const, y: 0.75, animation: 'pop' as const, background: '#000000' },
  { label: 'Faixa de nome', text: 'Nome Sobrenome\nCargo', fontSize: 48, fontWeight: 700 as const, y: 0.82, animation: 'slide-up' as const, background: '#16181D' },
]

export function TextPanel() {
  const doc = useDoc()
  const { apply, playhead, select } = useEditor()
  function add(p: (typeof TEXT_PRESETS)[number]) {
    const track = doc.tracks.find((t) => t.kind === 'text' && !t.locked) ?? doc.tracks.find((t) => t.kind === 'overlay' && !t.locked)
    if (!track) return
    const dur = quantize(secondsToFlicks(4), doc.settings.fps)
    const at = findFreeSlot(track, quantize(playhead, doc.settings.fps), dur)
    const clip = makeTextClip(p.text, at, dur)
    if (clip.type === 'text') {
      clip.style = { ...clip.style, fontSize: p.fontSize, fontWeight: p.fontWeight, background: p.background, color: p.background === '#F2A93B' ? '#1A1205' : '#FFFFFF' }
      clip.transform = { ...clip.transform, y: p.y }
      clip.animation = p.animation
      clip.name = p.label
    }
    if (apply((d) => addClip(d, track.id, clip))) select([clip.id])
  }
  return (
    <div className="p-3 flex flex-col gap-2">
      <p className="text-[12px] text-[var(--color-muted)]">Os textos usam a fonte Inter (licença OFL) e são idênticos na prévia e na exportação.</p>
      {TEXT_PRESETS.map((p) => (
        <button key={p.label} onClick={() => add(p)} className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3 text-left hover:border-[var(--color-accent)]">
          <Type size={18} className="text-[var(--color-accent)]" />
          <span className="flex-1">
            <span className="block font-medium text-sm">{p.label}</span>
            <span className="block text-[12px] text-[var(--color-muted)]">Animação: {p.animation}</span>
          </span>
          <Plus size={16} />
        </button>
      ))}
    </div>
  )
}

export function AudioPanel() {
  const doc = useDoc()
  const { workspaceId, apply, playhead, select, upsertAsset } = useEditor()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [sfx, setSfx] = useState(false)
  const [items, setItems] = useState<MusicDto[] | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      api<MusicDto[]>(`/workspaces/${workspaceId}/music?sfx=${sfx}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { signal: ctrl.signal })
        .then(setItems)
        .catch((e) => e.name !== 'AbortError' && toast(errorMessage(e), 'danger'))
    }, 250)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [q, sfx, workspaceId, toast])
  useEffect(() => () => audio.current?.pause(), [])
  function preview(m: MusicDto) {
    if (playing === m.id) {
      audio.current?.pause()
      setPlaying(null)
      return
    }
    audio.current?.pause()
    audio.current = new Audio(m.url)
    audio.current.onended = () => setPlaying(null)
    void audio.current.play()
    setPlaying(m.id)
  }
  async function ensureAsset(m: MusicDto) {
    const [a] = await api<Array<Parameters<typeof upsertAsset>[0]>>('/assets/batch', { body: { ids: [m.assetId] } })
    if (a) upsertAsset(a)
  }
  async function addOnce(m: MusicDto) {
    await ensureAsset(m)
    const kind = m.isSfx ? 'audio' : 'music'
    const track = doc.tracks.find((t) => t.kind === kind && !t.locked)
    if (!track) return toast('Adicione uma trilha de música/áudio.', 'danger')
    const dur = quantize(m.durationFlicks, doc.settings.fps, 'floor')
    const at = findFreeSlot(track, quantize(playhead, doc.settings.fps), dur)
    const clip = makeMediaClip('audio', m.assetId, at, dur, m.title)
    if (apply((d) => addClip(d, track.id, clip))) select([clip.id])
  }
  async function fill(m: MusicDto) {
    await ensureAsset(m)
    if (docDuration(doc) === 0) return toast('Adicione conteúdo antes de preencher com música.', 'danger')
    apply((d) => executeCommand(d, { type: 'replaceMusic', musicTrackId: m.id, assetId: m.assetId, durationFlicks: m.durationFlicks, title: m.title }))
    toast(`"${m.title}" cobre o vídeo inteiro (loop + fades).`, 'ok')
  }
  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex gap-2">
        <Input placeholder="Buscar por nome, clima, gênero" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar música" />
        <Select aria-label="Tipo" value={sfx ? 'sfx' : 'music'} onChange={(e) => setSfx(e.target.value === 'sfx')} className="w-32">
          <option value="music">Músicas</option>
          <option value="sfx">Efeitos</option>
        </Select>
      </div>
      {items === null ? (
        <Spinner />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((m) => (
            <li key={m.id} className="rounded-lg border border-[var(--color-border)] p-2.5 flex flex-col gap-1.5 bg-[var(--color-bg)]">
              <div className="flex items-center gap-2">
                <button onClick={() => preview(m)} aria-label={playing === m.id ? `Pausar ${m.title}` : `Ouvir ${m.title}`} className="w-8 h-8 rounded-full bg-[var(--color-surface-2)] flex items-center justify-center">
                  {playing === m.id ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate">{m.title}</div>
                  <div className="text-[11px] text-[var(--color-muted)] truncate">
                    {m.mood} · {m.genre} · {formatClock(m.durationFlicks)}
                    {m.bpm ? ` · ${m.bpm} BPM` : ''}
                  </div>
                </div>
                {m.favorite && <Star size={12} className="text-[var(--color-accent)]" fill="currentColor" aria-label="Favorita" />}
              </div>
              <div className="flex flex-wrap gap-1 items-center">
                <Badge tone={m.license.commercialUse ? 'ok' : 'danger'}>{m.license.licenseName}</Badge>
                {m.license.attributionRequired && <Badge tone="warn">Exige atribuição</Badge>}
                <span className="ml-auto flex gap-1">
                  <Button size="sm" onClick={() => addOnce(m)}>
                    Adicionar
                  </Button>
                  {!m.isSfx && (
                    <Button size="sm" icon={<Repeat size={12} />} onClick={() => fill(m)}>
                      Cobrir vídeo
                    </Button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-[var(--color-muted)]">Somente faixas com licença registrada aparecem aqui. Acesso a streaming não concede direito de sincronização.</p>
      <TrackVolumes />
    </div>
  )
}

function TrackVolumes() {
  const doc = useDoc()
  const apply = useEditor((s) => s.apply)
  const music = doc.tracks.find((t) => t.kind === 'music')
  if (!music) return null
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <input type="checkbox" checked={music.duckUnderVoice} onChange={(e) => apply((d) => ({ ...d, tracks: d.tracks.map((t) => (t.id === music.id ? { ...t, duckUnderVoice: e.target.checked } : t)) }))} />
      Abaixar a música durante a narração
    </label>
  )
}

