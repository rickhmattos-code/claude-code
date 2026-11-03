import type { BrandKitBody, TimelineDoc } from '@orion/shared'
import { produce } from 'immer'
import { clipEnd, docDuration } from './evaluate.ts'
import { makeMediaClip, makeTextClip, newId } from './ops.ts'
import { quantize, secondsToFlicks } from './time.ts'

export interface BrandAssets {
  logo?: { assetId: string }
  watermark?: { assetId: string }
  intro?: { assetId: string; type: 'video' | 'image'; durationFlicks: number }
  outro?: { assetId: string; type: 'video' | 'image'; durationFlicks: number }
}

export interface BrandApplyOptions {
  textColors: boolean
  captions: boolean
  watermark: boolean
  intro: boolean
  outro: boolean
  signature: boolean
}

const BRAND_TAG = 'brand:'

/**
 * Aplica a identidade visual a um projeto (idempotente: reaplicar substitui
 * os elementos de marca anteriores em vez de duplicá-los).
 */
export function applyBrandKit(
  doc: TimelineDoc,
  kit: BrandKitBody & { id: string },
  assets: BrandAssets,
  opts: BrandApplyOptions,
): TimelineDoc {
  const fps = doc.settings.fps
  const q = (s: number) => quantize(secondsToFlicks(s), fps)
  return produce(doc, (d) => {
    // remove elementos de marca anteriores (sceneKey começa com "brand:")
    let removedIntro = 0
    for (const t of d.tracks) {
      for (const c of t.clips) if (c.sceneKey === `${BRAND_TAG}intro`) removedIntro = Math.max(removedIntro, c.duration)
      t.clips = t.clips.filter((c) => !c.sceneKey?.startsWith(BRAND_TAG))
    }
    if (removedIntro > 0) {
      for (const t of d.tracks) for (const c of t.clips) c.start = Math.max(0, c.start - removedIntro)
      for (const s of d.captions.segments) {
        s.start = Math.max(0, s.start - removedIntro)
        s.end = Math.max(s.start + 1, s.end - removedIntro)
      }
    }
    const main = d.tracks.find((t) => t.kind === 'video')
    const overlay = d.tracks.find((t) => t.kind === 'overlay')
    const textTrack = d.tracks.find((t) => t.kind === 'text') ?? overlay

    if (opts.textColors) {
      for (const t of d.tracks)
        for (const c of t.clips)
          if (c.type === 'text') {
            c.style.color = kit.palette.text
            c.style.fontFamily = kit.fonts.heading
            if (c.style.background) c.style.background = kit.palette.primary
          }
      d.settings.background = kit.palette.background
    }
    if (opts.captions) {
      const style = d.captionStyles.find((s) => s.id === d.captions.styleId)
      if (style) {
        style.fontFamily = kit.fonts.body
        if (kit.captionStyleOverrides.color) style.color = kit.captionStyleOverrides.color
        style.highlightColor = kit.captionStyleOverrides.highlightColor ?? kit.palette.primary
        if (kit.captionStyleOverrides.fontWeight) style.fontWeight = kit.captionStyleOverrides.fontWeight
      }
    }
    if (opts.intro && assets.intro && main) {
      const dur = assets.intro.type === 'image' ? q(2) : quantize(assets.intro.durationFlicks, fps, 'floor')
      for (const t of d.tracks) for (const c of t.clips) c.start += dur
      for (const s of d.captions.segments) {
        s.start += dur
        s.end += dur
        if (s.words) for (const w of s.words) {
          w.start += dur
          w.end += dur
        }
      }
      for (const m of d.markers) m.time += dur
      const clip = makeMediaClip(assets.intro.type, assets.intro.assetId, 0, dur, 'Vinheta de abertura')
      clip.sceneKey = `${BRAND_TAG}intro`
      main.clips.unshift(clip)
    }
    const total = docDuration(d as TimelineDoc)
    if (opts.outro && assets.outro && main) {
      const dur = assets.outro.type === 'image' ? q(3) : quantize(assets.outro.durationFlicks, fps, 'floor')
      const start = main.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
      const clip = makeMediaClip(assets.outro.type, assets.outro.assetId, start, dur, 'Vinheta de encerramento')
      clip.sceneKey = `${BRAND_TAG}outro`
      clip.transitionIn = { type: 'fade', duration: q(0.4) }
      main.clips.push(clip)
    }
    const fullDuration = docDuration(d as TimelineDoc)
    if (opts.watermark && assets.watermark && overlay && fullDuration > 0) {
      const free = !overlay.clips.length
      const target = free
        ? overlay
        : (() => {
            const t = { ...overlay, id: newId(), name: 'Marca-d’água', clips: [] }
            d.tracks.push(t)
            return t
          })()
      const clip = makeMediaClip('image', assets.watermark.assetId, 0, fullDuration, 'Marca-d’água')
      clip.fit = 'contain'
      clip.transform = { x: 0.88, y: 0.07, scale: 0.12, rotation: 0, opacity: 0.7 }
      clip.sceneKey = `${BRAND_TAG}watermark`
      target.clips.push(clip)
    }
    if (opts.signature && textTrack && fullDuration > 0) {
      const sigText = [kit.displayName, kit.socialHandle].filter(Boolean).join('\n')
      const dur = Math.min(q(3), fullDuration)
      const start = Math.max(0, fullDuration - dur)
      const free = !textTrack.clips.some((c) => start < clipEnd(c) && start + dur > c.start)
      const target = free
        ? textTrack
        : (() => {
            const t = { ...textTrack, id: newId(), name: 'Assinatura', clips: [] }
            d.tracks.push(t)
            return t
          })()
      const clip = makeTextClip(sigText, start, dur)
      if (clip.type === 'text') {
        clip.style = { ...clip.style, fontSize: 52, fontWeight: 700, color: kit.palette.text, background: kit.palette.primary, fontFamily: kit.fonts.heading }
        clip.transform = { ...clip.transform, y: 0.86 }
        clip.animation = 'slide-up'
      }
      clip.sceneKey = `${BRAND_TAG}signature`
      clip.name = 'Assinatura'
      target.clips.push(clip)
    }
    for (const t of d.tracks) t.clips.sort((a, b) => a.start - b.start)
    d.meta.brandKitId = kit.id
    void total
  })
}
