'use client'
import type { Clip, Track, TrackKind } from '@orion/shared'
import {
  FLICKS_PER_SECOND,
  TRACK_ACCEPTS,
  addClip,
  addTrack,
  clipEnd,
  docDuration,
  findFreeSlot,
  formatClock,
  makeMediaClip,
  moveClip,
  quantize,
  removeMarker,
  removeTrack,
  setTrackFlags,
  snapCandidates,
  snapTime,
  trimClip,
} from '@orion/timeline'
import { Select } from '@orion/ui'
import { Eye, EyeOff, Headphones, Lock, LockOpen, Trash2, Volume2, VolumeX } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDoc, useEditor } from './store'

const HEADER_FULL = 212
const HEADER_COMPACT = 116
const RULER_H = 26
const ROW_H: Record<TrackKind, number> = { video: 56, overlay: 44, text: 36, audio: 44, voice: 48, music: 44 }
const CAPTION_H = 28
const SNAP_PX = 8

export const TRACK_COLORS: Record<TrackKind, string> = {
  video: 'var(--track-video)',
  overlay: 'var(--track-overlay)',
  text: 'var(--track-text)',
  audio: 'var(--track-audio)',
  voice: 'var(--track-voice)',
  music: 'var(--track-music)',
}

export interface DraggedAsset {
  assetId: string
  kind: 'VIDEO' | 'AUDIO' | 'IMAGE'
  durationFlicks: number | null
  name: string
}
export const ASSET_MIME = 'application/x-orion-asset'

const peaksCache = new Map<string, Promise<{ peaksPerSecond: number; peaks: number[] } | null>>()
export function loadPeaks(url: string, assetId: string) {
  let p = peaksCache.get(assetId)
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    peaksCache.set(assetId, p)
  }
  return p
}

const Waveform = memo(function Waveform({ clip, width, height }: { clip: Extract<Clip, { type: 'audio' | 'video' }>; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const asset = useEditor((s) => s.assets[clip.assetId])
  useEffect(() => {
    if (!asset?.waveformUrl || !ref.current) return
    let alive = true
    const w = Math.min(4000, Math.max(1, Math.round(width)))
    void loadPeaks(asset.waveformUrl, asset.id).then((data) => {
      const c = ref.current
      if (!alive || !data || !c) return
      c.width = w
      c.height = height
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, w, height)
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      const start = (clip.sourceIn / FLICKS_PER_SECOND) * data.peaksPerSecond
      const span = ((clip.duration * clip.speed) / FLICKS_PER_SECOND) * data.peaksPerSecond
      for (let x = 0; x < w; x++) {
        const i = Math.floor(start + (x / w) * span)
        const v = (data.peaks[i] ?? 0) * clip.volume
        const h = Math.max(1, Math.min(1, v) * (height - 4))
        ctx.fillRect(x, (height - h) / 2, 1, h)
      }
    })
    return () => {
      alive = false
    }
  }, [asset?.waveformUrl, asset?.id, clip.sourceIn, clip.duration, clip.speed, clip.volume, width, height])
  return <canvas ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true" />
})

interface DragState {
  mode: 'move' | 'trim-start' | 'trim-end'
  clipId: string
  trackId: string
  origStart: number
  origDuration: number
  startX: number
  start: number
  duration: number
  targetTrackId: string
  snapped: number | null
  moved: boolean
}

export function Timeline() {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const on = () => setCompact(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  // telas estreitas: cabeçalho compacto (demais controles no inspetor da trilha)
  const HEADER_W = compact ? HEADER_COMPACT : HEADER_FULL
  const doc = useDoc()
  const { apply, select, selection, playhead, setPlayhead, pxPerSec, setZoom, snap, assets, selectTrack, selectedTrackId, selectCaption, selectedCaptionId } = useEditor()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const fps = doc.settings.fps
  const total = docDuration(doc)
  const width = Math.max(((total + 30 * FLICKS_PER_SECOND) / FLICKS_PER_SECOND) * pxPerSec, 800)
  const toPx = useCallback((f: number) => (f / FLICKS_PER_SECOND) * pxPerSec, [pxPerSec])
  const toFlicks = useCallback((px: number) => Math.max(0, Math.round((px / pxPerSec) * FLICKS_PER_SECOND)), [pxPerSec])

  // ordem de exibição: trilhas visuais (de cima para baixo = mais alta primeiro), depois áudio
  const rows = useMemo(() => {
    const visual = doc.tracks.filter((t) => t.kind === 'video' || t.kind === 'overlay' || t.kind === 'text').reverse()
    const audio = doc.tracks.filter((t) => !(t.kind === 'video' || t.kind === 'overlay' || t.kind === 'text'))
    let y = RULER_H
    return [...visual, ...audio].map((t) => {
      const r = { track: t, y, h: ROW_H[t.kind] }
      y += r.h
      return r
    })
  }, [doc.tracks])
  const captionsY = (rows[rows.length - 1]?.y ?? RULER_H) + (rows[rows.length - 1]?.h ?? 0)
  const contentH = captionsY + CAPTION_H + 8

  const trackAtY = (y: number) => rows.find((r) => y >= r.y && y < r.y + r.h)?.track ?? null

  const localX = (e: { clientX: number }) => {
    const el = scrollRef.current!
    return e.clientX - el.getBoundingClientRect().left + el.scrollLeft - HEADER_W
  }
  const localY = (e: { clientY: number }) => {
    const el = scrollRef.current!
    return e.clientY - el.getBoundingClientRect().top + el.scrollTop
  }

  function onClipPointerDown(e: React.PointerEvent, clip: Clip, track: Track) {
    if (e.button !== 0) return
    e.stopPropagation()
    const target = e.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const edge = 8
    const mode: DragState['mode'] = e.clientX - rect.left < edge ? 'trim-start' : rect.right - e.clientX < edge ? 'trim-end' : 'move'
    select([clip.id], e.shiftKey || e.metaKey || e.ctrlKey)
    if (track.locked) return
    const s: DragState = { mode, clipId: clip.id, trackId: track.id, origStart: clip.start, origDuration: clip.duration, startX: e.clientX, start: clip.start, duration: clip.duration, targetTrackId: track.id, snapped: null, moved: false }
    dragRef.current = s
    setDrag(s)
    scrollRef.current?.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = dragRef.current
    if (!s) {
      if (e.buttons === 1 && scrubbing.current) setPlayhead(quantize(toFlicks(localX(e)), fps))
      return
    }
    const dx = toFlicks(Math.abs(e.clientX - s.startX)) * Math.sign(e.clientX - s.startX)
    if (!s.moved && Math.abs(e.clientX - s.startX) < 3) return
    const thr = toFlicks(SNAP_PX)
    const cands = snap ? snapCandidates(doc, { exclude: new Set([s.clipId]), playhead }) : []
    let next: DragState = { ...s, moved: true }
    if (s.mode === 'move') {
      let start = Math.max(0, s.origStart + dx)
      let snapped: number | null = null
      if (snap) {
        const a = snapTime(start, cands, thr)
        const b = snapTime(start + s.origDuration, cands, thr)
        if (a.snapped && (!b.snapped || Math.abs(a.time - start) <= Math.abs(b.time - start - s.origDuration))) {
          start = a.time
          snapped = a.time
        } else if (b.snapped) {
          start = b.time - s.origDuration
          snapped = b.time
        }
      }
      const over = trackAtY(localY(e))
      next = { ...next, start: quantize(Math.max(0, start), fps), targetTrackId: over?.id ?? s.targetTrackId, snapped }
    } else if (s.mode === 'trim-start') {
      let start = Math.min(s.origStart + s.origDuration - 1, Math.max(0, s.origStart + dx))
      const r = snap ? snapTime(start, cands, thr) : { time: start, snapped: false }
      start = quantize(r.time, fps)
      next = { ...next, start, duration: s.origStart + s.origDuration - start, snapped: r.snapped ? r.time : null }
    } else {
      let end = Math.max(s.origStart + 1, s.origStart + s.origDuration + dx)
      const r = snap ? snapTime(end, cands, thr) : { time: end, snapped: false }
      end = quantize(r.time, fps)
      next = { ...next, duration: end - s.origStart, snapped: r.snapped ? r.time : null }
    }
    dragRef.current = next
    setDrag(next)
  }

  function onPointerUp() {
    scrubbing.current = false
    const s = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!s || !s.moved) return
    if (s.mode === 'move') apply((d) => moveClip(d, s.clipId, s.targetTrackId, s.start))
    else if (s.mode === 'trim-start') apply((d) => trimClip(d, s.clipId, 'start', s.start))
    else {
      const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === s.clipId)
      const srcDur = clip && 'assetId' in clip ? (assets[clip.assetId]?.durationFlicks ?? undefined) : undefined
      apply((d) => trimClip(d, s.clipId, 'end', s.start + s.duration, srcDur ?? undefined))
    }
  }

  const scrubbing = useRef(false)

  // rolagem acompanha o cursor durante a reprodução
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !useEditor.getState().playing) return
    const x = toPx(playhead) + HEADER_W
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft + HEADER_W) el.scrollLeft = Math.max(0, x - HEADER_W - 60)
  }, [playhead, toPx])

  function onDrop(e: React.DragEvent) {
    const raw = e.dataTransfer.getData(ASSET_MIME)
    if (!raw) return
    e.preventDefault()
    const a = JSON.parse(raw) as DraggedAsset
    const type = a.kind === 'VIDEO' ? 'video' : a.kind === 'IMAGE' ? 'image' : 'audio'
    const over = trackAtY(localY(e))
    const track = over && TRACK_ACCEPTS[over.kind].includes(type) && !over.locked ? over : doc.tracks.find((t) => TRACK_ACCEPTS[t.kind].includes(type) && !t.locked && (type !== 'audio' || t.kind === 'audio'))
    if (!track) return
    const dur = quantize(a.durationFlicks ?? 5 * FLICKS_PER_SECOND, fps, 'floor')
    const at = findFreeSlot(track, quantize(toFlicks(localX(e)), fps), dur)
    const clip = makeMediaClip(type, a.assetId, at, dur, a.name)
    if (apply((d) => addClip(d, track.id, clip))) select([clip.id])
  }

  // marcas da régua
  const tickSec = pxPerSec > 150 ? 0.5 : pxPerSec > 60 ? 1 : pxPerSec > 25 ? 5 : pxPerSec > 8 ? 10 : 30
  const ticks: number[] = []
  for (let s = 0; s <= width / pxPerSec; s += tickSec) ticks.push(s)

  const clipsById = new Map(doc.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)))
  const draggedClip = drag ? clipsById.get(drag.clipId) : null

  return (
    <section aria-label="Timeline" className="flex flex-col h-full min-h-0 bg-[var(--color-surface)] border-t border-[var(--color-border)]">
      <div className="flex items-center gap-3 px-3 h-9 border-b border-[var(--color-border)] text-[12px]">
        <label className="flex items-center gap-2 text-[var(--color-muted)]">
          Zoom
          <input type="range" className="orion-range w-28" min={4} max={400} step={1} value={pxPerSec} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom da timeline" />
        </label>
        <span className="text-[var(--color-muted)]">Duração: {formatClock(total)}</span>
        <div className="ml-auto flex items-center gap-1">
          <Select
            aria-label="Adicionar trilha"
            value=""
            className="h-7 w-auto text-[12px]"
            onChange={(e) => {
              if (e.target.value) apply((d) => addTrack(d, e.target.value as TrackKind))
              e.currentTarget.value = ''
            }}
          >
            <option value="">+ Adicionar trilha</option>
            <option value="video">Vídeo</option>
            <option value="overlay">Sobreposição</option>
            <option value="text">Texto</option>
            <option value="voice">Narração</option>
            <option value="music">Música</option>
            <option value="audio">Áudio/efeitos</option>
          </Select>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="relative flex-1 min-h-0 overflow-auto select-none touch-none"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(ASSET_MIME)) e.preventDefault()
        }}
        onDrop={onDrop}
      >
        <div className="relative" style={{ width: width + HEADER_W, height: contentH }}>
          {/* régua */}
          <div
            className="sticky top-0 z-20 h-[26px] bg-[var(--color-surface)] border-b border-[var(--color-border)] cursor-text"
            style={{ marginLeft: HEADER_W, width }}
            onPointerDown={(e) => {
              scrubbing.current = true
              scrollRef.current?.setPointerCapture(e.pointerId)
              setPlayhead(quantize(toFlicks(localX(e)), fps))
            }}
            role="slider"
            aria-label="Posição do cursor"
            aria-valuemin={0}
            aria-valuemax={Math.round(total / FLICKS_PER_SECOND)}
            aria-valuenow={Math.round(playhead / FLICKS_PER_SECOND)}
            tabIndex={0}
          >
            {ticks.map((s) => (
              <div key={s} className="absolute top-0 h-full border-l border-[var(--color-border-strong)]" style={{ left: s * pxPerSec }}>
                <span className="absolute top-1 left-1 text-[10px] text-[var(--color-muted)] tabular-nums">{formatClock(s * FLICKS_PER_SECOND)}</span>
              </div>
            ))}
            {doc.markers.map((m) => (
              <button
                key={m.id}
                className="absolute bottom-0 -translate-x-1/2 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent"
                style={{ left: toPx(m.time), borderTopColor: m.color }}
                title={`${m.label} — clique para ir; Alt+clique remove`}
                aria-label={`Marcador ${m.label}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => (e.altKey ? apply((d) => removeMarker(d, m.id)) : setPlayhead(m.time))}
              />
            ))}
          </div>
          {/* trilhas */}
          {rows.map(({ track, y, h }) => (
            <div key={track.id} className="absolute left-0 flex" style={{ top: y, height: h, width: width + HEADER_W }}>
              <div
                className={`sticky left-0 z-10 flex items-center gap-0.5 px-2 border-b border-r border-[var(--color-border)] bg-[var(--color-surface)] ${selectedTrackId === track.id ? 'outline outline-1 -outline-offset-1 outline-[var(--color-blue)]' : ''}`}
                style={{ width: HEADER_W, height: h }}
                onClick={() => selectTrack(track.id)}
              >
                <span className="w-1.5 h-6 rounded-full shrink-0" style={{ background: TRACK_COLORS[track.kind] }} aria-hidden="true" />
                <span className="text-[12px] truncate flex-1 ml-1" title={track.name}>
                  {track.name}
                </span>
                {track.kind !== 'text' && (
                  <IconToggle label={track.muted ? 'Ativar som' : 'Silenciar'} on={track.muted} onClick={() => apply((d) => setTrackFlags(d, track.id, { muted: !track.muted }))} icon={track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />} />
                )}
                {!compact && track.kind !== 'text' && <IconToggle label="Solo" on={track.solo} onClick={() => apply((d) => setTrackFlags(d, track.id, { solo: !track.solo }))} icon={<Headphones size={13} />} />}
                <IconToggle label={track.locked ? 'Desbloquear' : 'Bloquear'} on={track.locked} onClick={() => apply((d) => setTrackFlags(d, track.id, { locked: !track.locked }))} icon={track.locked ? <Lock size={13} /> : <LockOpen size={13} />} />
                {!compact && (track.kind === 'video' || track.kind === 'overlay' || track.kind === 'text') && (
                  <IconToggle label={track.hidden ? 'Mostrar' : 'Ocultar'} on={track.hidden} onClick={() => apply((d) => setTrackFlags(d, track.id, { hidden: !track.hidden }))} icon={track.hidden ? <EyeOff size={13} /> : <Eye size={13} />} />
                )}
                {!compact && track.clips.length === 0 && doc.tracks.length > 1 && <IconToggle label="Remover trilha vazia" on={false} onClick={() => apply((d) => removeTrack(d, track.id))} icon={<Trash2 size={13} />} />}
              </div>
              <div className={`relative border-b border-[var(--color-border)] ${track.locked ? 'bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(255,255,255,0.02)_6px,rgba(255,255,255,0.02)_12px)]' : ''}`} style={{ width, height: h, opacity: track.hidden || track.muted ? 0.5 : 1 }}>
                {track.clips.map((c) => {
                  const isDragged = drag?.clipId === c.id
                  if (isDragged && drag.mode === 'move' && drag.targetTrackId !== track.id) return null
                  const start = isDragged ? drag.start : c.start
                  const dur = isDragged ? drag.duration : c.duration
                  return <ClipBlock key={c.id} clip={c} track={track} left={toPx(start)} width={Math.max(4, toPx(dur))} height={h} selected={selection.includes(c.id)} onPointerDown={(e) => onClipPointerDown(e, c, track)} onSelect={() => select([c.id])} />
                })}
                {drag && drag.mode === 'move' && drag.targetTrackId === track.id && drag.trackId !== track.id && draggedClip && (
                  <ClipBlock clip={draggedClip} track={track} left={toPx(drag.start)} width={Math.max(4, toPx(drag.duration))} height={h} selected ghost onPointerDown={() => undefined} onSelect={() => undefined} />
                )}
              </div>
            </div>
          ))}
          {/* legendas */}
          <div className="absolute left-0 flex" style={{ top: captionsY, height: CAPTION_H, width: width + HEADER_W }}>
            <div className="sticky left-0 z-10 flex items-center px-3 text-[12px] text-[var(--color-muted)] border-r border-[var(--color-border)] bg-[var(--color-surface)]" style={{ width: HEADER_W }}>
              Legendas ({doc.captions.segments.length})
            </div>
            <div className="relative" style={{ width }}>
              {doc.captions.segments.map((s) => (
                <button
                  key={s.id}
                  className={`absolute top-1 bottom-1 rounded px-1 text-[10px] text-left truncate border ${selectedCaptionId === s.id ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/25' : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)]'}`}
                  style={{ left: toPx(s.start), width: Math.max(6, toPx(s.end - s.start)) }}
                  title={s.text}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    selectCaption(s.id)
                    setPlayhead(s.start)
                  }}
                >
                  {s.text}
                </button>
              ))}
            </div>
          </div>
          {/* cursor de reprodução e guia de imã */}
          <div className="absolute top-0 z-30 w-px bg-[var(--color-accent)] pointer-events-none" style={{ left: HEADER_W + toPx(playhead), height: contentH }} aria-hidden="true">
            <div className="absolute -left-[5px] top-0 w-[11px] h-[11px] rotate-45 bg-[var(--color-accent)]" />
          </div>
          {drag?.snapped !== null && drag?.snapped !== undefined && (
            <div className="absolute top-0 z-30 w-px bg-[var(--color-blue)] pointer-events-none" style={{ left: HEADER_W + toPx(drag.snapped), height: contentH }} aria-hidden="true" />
          )}
        </div>
      </div>
    </section>
  )
}

function IconToggle({ label, on, onClick, icon }: { label: string; on: boolean; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`w-6 h-6 inline-flex items-center justify-center rounded ${on ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/15' : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'}`}
    >
      {icon}
    </button>
  )
}

const ClipBlock = memo(function ClipBlock({ clip, track, left, width, height, selected, ghost, onPointerDown, onSelect }: { clip: Clip; track: Track; left: number; width: number; height: number; selected: boolean; ghost?: boolean; onPointerDown: (e: React.PointerEvent) => void; onSelect: () => void }) {
  const asset = useEditor((s) => ('assetId' in clip ? s.assets[clip.assetId] : undefined))
  const label = clip.type === 'text' ? clip.text : clip.name
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Clipe ${label}`}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect()
      }}
      className={`absolute top-0.5 bottom-0.5 rounded-md overflow-hidden text-[11px] text-white cursor-grab active:cursor-grabbing ${selected ? 'ring-2 ring-[var(--color-accent)] z-10' : 'ring-1 ring-black/40'} ${ghost ? 'opacity-60' : ''}`}
      style={{ left, width, background: TRACK_COLORS[track.kind] }}
    >
      {clip.type === 'video' && asset?.thumbnailUrl && width > 40 && (
        <div className="absolute inset-0 opacity-40 bg-repeat-x bg-contain" style={{ backgroundImage: `url(${asset.thumbnailUrl})` }} aria-hidden="true" />
      )}
      {clip.type === 'image' && asset?.thumbnailUrl && <div className="absolute inset-0 opacity-40 bg-cover bg-center" style={{ backgroundImage: `url(${asset.thumbnailUrl})` }} aria-hidden="true" />}
      {clip.type === 'color' && <div className="absolute inset-y-0 left-0 w-3" style={{ background: clip.color }} aria-hidden="true" />}
      {(clip.type === 'audio' || (clip.type === 'video' && asset?.hasAudio)) && height >= 44 && <Waveform clip={clip as Extract<Clip, { type: 'audio' | 'video' }>} width={width} height={clip.type === 'video' ? 18 : height - 4} />}
      <div className="relative px-2 py-0.5 truncate font-medium drop-shadow">
        {clip.transitionIn && <span title={`Transição: ${clip.transitionIn.type}`}>◢ </span>}
        {label}
        {'speed' in clip && clip.speed !== 1 && <span className="ml-1 opacity-80">{clip.speed}×</span>}
      </div>
      {clip.keyframes.length > 0 && (
        <div className="absolute bottom-0.5 left-0 right-0 h-2 pointer-events-none" aria-hidden="true">
          {clip.keyframes.map((k) => (
            <span key={k.id} className="absolute w-1.5 h-1.5 rotate-45 bg-[var(--color-accent)]" style={{ left: `${(k.time / clip.duration) * 100}%` }} />
          ))}
        </div>
      )}
      <div className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-white/20" aria-hidden="true" />
      <div className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/20" aria-hidden="true" />
      <span className="sr-only">
        Início {formatClock(clip.start)}, fim {formatClock(clipEnd(clip))}
      </span>
    </div>
  )
})
