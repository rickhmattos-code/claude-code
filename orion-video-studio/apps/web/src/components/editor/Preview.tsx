'use client'
import type { AnyMediaClip, Clip, TimelineDoc } from '@orion/shared'
import { FLICKS_PER_SECOND, audibleTracks, clipEnd, dissolveExtensions, docDuration, formatTimecode, isMediaClip, voiceIntervals, volumeAt } from '@orion/timeline'
import { Select, ToolButton } from '@orion/ui'
import { Pause, Play, SkipBack } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type MediaSource, composeFrame } from './compositor'
import { useDoc, useEditor } from './store'

/**
 * Prévia com motor de reprodução: relógio mestre (performance.now) e pool de
 * elementos <video>/<audio> sincronizados por clipe (correção de deriva
 * > 150 ms). Usa proxies 540p quando disponíveis. Nada de processamento
 * pesado no navegador: a exportação é sempre feita no worker.
 */

const PRELOAD_WINDOW = 8 * FLICKS_PER_SECOND
const DRIFT_SEC = 0.15
const DUCK_GAIN = 0.35

interface PoolItem {
  el: HTMLVideoElement | HTMLAudioElement
  assetId: string
  src: string
}

const SAFE: Record<string, { action: number; title: number; social?: { top: number; bottom: number; side: number } }> = {
  action: { action: 0.05, title: 0.05 },
  title: { action: 0.1, title: 0.1 },
  social: { action: 0.05, title: 0.1, social: { top: 0.12, bottom: 0.2, side: 0.06 } },
}

export function Preview() {
  const doc = useDoc()
  const assets = useEditor((s) => s.assets)
  const playing = useEditor((s) => s.playing)
  const playhead = useEditor((s) => s.playhead)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setPlaying = useEditor((s) => s.setPlaying)
  const apply = useEditor((s) => s.apply)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const pool = useRef(new Map<string, PoolItem>())
  const images = useRef(new Map<string, HTMLImageElement>())
  const clock = useRef({ startPerf: 0, startT: 0 })
  const tRef = useRef(playhead)
  const docRef = useRef(doc)
  const assetsRef = useRef(assets)
  docRef.current = doc
  assetsRef.current = assets
  const [box, setBox] = useState({ w: 320, h: 568 })
  const [quality, setQuality] = useState<'proxy' | 'original'>('proxy')

  const W0 = doc.settings.width
  const H0 = doc.settings.height
  const scale = Math.min(1, 1280 / Math.max(W0, H0))
  const CW = Math.round(W0 * scale)
  const CH = Math.round(H0 * scale)

  // tamanho visual do canvas preservando proporção
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e!.contentRect
      const s = Math.min(width / W0, height / H0)
      setBox({ w: Math.max(80, Math.floor(W0 * s)), h: Math.max(80, Math.floor(H0 * s)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [W0, H0])

  // play/pause → relógio mestre
  useEffect(() => {
    if (playing) {
      clock.current = { startPerf: performance.now(), startT: useEditor.getState().playhead }
    } else {
      for (const p of pool.current.values()) p.el.pause()
    }
  }, [playing])

  useEffect(() => {
    if (!playing) tRef.current = playhead
    else if (Math.abs(playhead - tRef.current) > FLICKS_PER_SECOND / 4) {
      // busca do usuário durante a reprodução: reinicia o relógio mestre
      tRef.current = playhead
      clock.current = { startPerf: performance.now(), startT: playhead }
    }
  }, [playhead, playing])

  // loop de desenho/sincronização
  useEffect(() => {
    let raf = 0
    let lastStore = 0
    let lastDiag = 0
    const probe = document.createElement('video')
    const mp4Ok = probe.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== ''
    const urlFor = (assetId: string) => {
      const a = assetsRef.current[assetId]
      if (!a) return null
      // navegadores sem H.264/AAC recebem a variante VP9/Opus
      const proxy = mp4Ok ? a.proxyUrl : (a.proxyWebmUrl ?? a.proxyUrl)
      return quality === 'proxy' || !mp4Ok ? (proxy ?? a.originalUrl) : (a.originalUrl ?? proxy)
    }
    const tick = (now: number) => {
      const d = docRef.current
      const total = docDuration(d)
      const st = useEditor.getState()
      let t = tRef.current
      if (st.playing) {
        t = clock.current.startT + Math.round(((now - clock.current.startPerf) / 1000) * FLICKS_PER_SECOND)
        if (t >= total) {
          t = total
          st.setPlaying(false)
        }
        tRef.current = t
        if (now - lastStore > 66) {
          st.setPlayhead(t)
          lastStore = now
        }
      }
      // ---- sincroniza elementos de mídia
      const wanted = new Set<string>()
      const audible = new Set(audibleTracks(d).map((tr) => tr.id))
      const voice = voiceIntervals(d)
      const inVoice = voice.some(([a, b]) => t >= a && t < b)
      for (const track of d.tracks) {
        const ext = dissolveExtensions(track)
        for (const c of track.clips) {
          if (!isMediaClip(c) || c.type === 'image') continue
          const end = clipEnd(c) + (ext.get(c.id) ?? 0)
          if (t < c.start - PRELOAD_WINDOW || t > end + FLICKS_PER_SECOND) continue
          const src = urlFor(c.assetId)
          if (!src) continue
          wanted.add(c.id)
          let item = pool.current.get(c.id)
          if (!item || item.src !== src) {
            item?.el.pause()
            const el = c.type === 'video' ? document.createElement('video') : document.createElement('audio')
            el.preload = 'auto'
            el.src = src
            if (el instanceof HTMLVideoElement) {
              el.playsInline = true
              el.muted = false
            }
            item = { el, assetId: c.assetId, src }
            pool.current.set(c.id, item)
          }
          const active = t >= c.start && t < end
          const el = item.el
          const local = (t - c.start) / FLICKS_PER_SECOND
          const desired = (c.sourceIn + (t - c.start) * c.speed) / FLICKS_PER_SECOND
          const mc = c as AnyMediaClip
          let vol = active ? track.volume * volumeAt(mc, local, ext.get(c.id) ?? 0) : 0
          if (track.kind === 'music' && track.duckUnderVoice && inVoice) vol *= DUCK_GAIN
          el.volume = Math.max(0, Math.min(1, vol))
          el.muted = !audible.has(track.id)
          if (active) {
            if (Math.abs(el.playbackRate - c.speed) > 1e-3) el.playbackRate = c.speed
            const dur = Number.isFinite(el.duration) ? el.duration : Number.POSITIVE_INFINITY
            const target = Math.min(desired, Math.max(0, dur - 0.05))
            if (st.playing) {
              if (Math.abs(el.currentTime - target) > DRIFT_SEC) el.currentTime = target
              if (el.paused && desired < dur) void el.play().catch(() => undefined)
            } else {
              if (!el.paused) el.pause()
              if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target
            }
          } else {
            if (!el.paused) el.pause()
            if (t < c.start) {
              const pre = c.sourceIn / FLICKS_PER_SECOND
              if (Math.abs(el.currentTime - pre) > 0.1 && el.readyState >= 1) el.currentTime = pre
            }
          }
        }
      }
      for (const [id, item] of pool.current) {
        if (!wanted.has(id)) {
          item.el.pause()
          item.el.removeAttribute('src')
          item.el.load()
          pool.current.delete(id)
        }
      }
      // ---- desenha
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && now - lastDiag > 500) {
        // diagnóstico exposto no DOM (usado pelos testes de interface)
        lastDiag = now
        canvas.dataset.media = [...pool.current.values()].map((p) => `${p.el.tagName.toLowerCase()}:${p.el.readyState}:${p.el.error?.code ?? 0}`).join(',')
      }
      if (canvas && ctx) {
        const durations: Record<string, number> = {}
        for (const a of Object.values(assetsRef.current)) if (a.durationFlicks) durations[a.id] = a.durationFlicks
        composeFrame(ctx, d, t, CW, CH, (clip: Clip): MediaSource | null => {
          if (clip.type === 'video') {
            const it = pool.current.get(clip.id)
            const v = it?.el as HTMLVideoElement | undefined
            return v && v.readyState >= 2 ? { el: v, width: v.videoWidth, height: v.videoHeight } : null
          }
          if (clip.type === 'image') {
            const a = assetsRef.current[clip.assetId]
            const url = a?.originalUrl
            if (!url) return null
            let img = images.current.get(clip.assetId)
            if (!img) {
              img = new Image()
              img.src = url
              images.current.set(clip.assetId, img)
            }
            return img.complete && img.naturalWidth ? { el: img, width: img.naturalWidth, height: img.naturalHeight } : null
          }
          return null
        }, durations)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [CW, CH, quality])

  useEffect(
    () => () => {
      for (const p of pool.current.values()) {
        p.el.pause()
        p.el.removeAttribute('src')
      }
      pool.current.clear()
    },
    [],
  )

  const safe = SAFE[doc.safeArea]
  return (
    <section aria-label="Prévia" className="flex flex-col h-full min-h-0">
      <div ref={wrapRef} className="flex-1 min-h-0 flex items-center justify-center p-2">
        <div className="relative shadow-2xl" style={{ width: box.w, height: box.h }}>
          <canvas ref={canvasRef} width={CW} height={CH} className="w-full h-full rounded-sm bg-black" aria-label="Quadro atual do vídeo" />
          {safe && (
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              <div className="absolute border border-dashed border-white/25" style={{ inset: `${safe.action * 100}%` }} />
              <div className="absolute border border-dashed border-[var(--color-accent)]/40" style={{ inset: `${safe.title * 100}%` }} />
              {safe.social && (
                <>
                  <div className="absolute left-0 right-0 top-0 bg-[var(--color-danger)]/10" style={{ height: `${safe.social.top * 100}%` }} />
                  <div className="absolute left-0 right-0 bottom-0 bg-[var(--color-danger)]/10" style={{ height: `${safe.social.bottom * 100}%` }} />
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 px-2 pb-1 flex-wrap">
        <ToolButton label="Início" shortcut="Home" icon={<SkipBack size={16} />} onClick={() => setPlayhead(0)} />
        <ToolButton label={playing ? 'Pausar' : 'Reproduzir'} shortcut="Espaço" icon={playing ? <Pause size={18} /> : <Play size={18} />} onClick={() => setPlaying(!playing)} />
        <span className="tabular-nums text-sm px-2" aria-live="off">
          {formatTimecode(playhead, doc.settings.fps)} / {formatTimecode(docDuration(doc), doc.settings.fps)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Select aria-label="Área segura" value={doc.safeArea} onChange={(e) => apply((d) => ({ ...d, safeArea: e.target.value as TimelineDoc['safeArea'] }))} className="h-8 w-auto text-[12px]">
            <option value="none">Sem guias</option>
            <option value="action">Área de ação</option>
            <option value="title">Área de título</option>
            <option value="social">Redes sociais</option>
          </Select>
          <Select aria-label="Qualidade da prévia" value={quality} onChange={(e) => setQuality(e.target.value as 'proxy' | 'original')} className="h-8 w-auto text-[12px]">
            <option value="proxy">Prévia leve (proxy)</option>
            <option value="original">Original</option>
          </Select>
        </div>
      </div>
    </section>
  )
}
