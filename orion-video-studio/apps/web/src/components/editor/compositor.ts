'use client'
import type { CaptionStyle, Clip, Effect, TimelineDoc } from '@orion/shared'
import {
  FLICKS_PER_SECOND,
  LINE_HEIGHT,
  TEXT_MAX_WIDTH_RATIO,
  activeVisualLayers,
  FONT_LINE_EM,
  fontPx,
  type MaskEffect,
  maskGeometry,
  masksOf,
  wrapCaptionTokens,
  wrapText,
} from '@orion/timeline'

/**
 * Compositor da prévia (Canvas 2D). Usa activeVisualLayers / visualStateAt
 * — as MESMAS funções que geram as expressões da exportação — para posição,
 * escala, rotação, opacidade, animações de texto e dissolves. Efeitos de cor
 * são aproximados (veja EFFECT_SUPPORT em @orion/shared).
 */

export interface MediaSource {
  /** elemento pronto para desenhar (vídeo com frame decodificado ou imagem carregada) */
  el: HTMLVideoElement | HTMLImageElement | null
  width: number
  height: number
}

function cssFilter(effects: Effect[], scale: number): string {
  const parts: string[] = []
  for (const e of effects) {
    if (e.type === 'color') parts.push(`brightness(${1 + e.brightness * 0.5}) contrast(${e.contrast}) saturate(${e.saturation})`)
    if (e.type === 'blur' && e.radius > 0) parts.push(`blur(${(e.radius * scale) / 2}px)`)
  }
  return parts.join(' ') || 'none'
}

let noise: HTMLCanvasElement | null = null
function noiseCanvas(): HTMLCanvasElement {
  if (noise) return noise
  noise = document.createElement('canvas')
  noise.width = noise.height = 128
  const ctx = noise.getContext('2d')!
  const img = ctx.createImageData(128, 128)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return noise
}

let keyCanvas: HTMLCanvasElement | null = null
function chromaKeyed(src: CanvasImageSource, w: number, h: number, e: Extract<Effect, { type: 'chromakey' }>): HTMLCanvasElement {
  keyCanvas ??= document.createElement('canvas')
  const scale = Math.min(1, 480 / Math.max(w, h))
  keyCanvas.width = Math.max(2, Math.round(w * scale))
  keyCanvas.height = Math.max(2, Math.round(h * scale))
  const ctx = keyCanvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0, keyCanvas.width, keyCanvas.height)
  const img = ctx.getImageData(0, 0, keyCanvas.width, keyCanvas.height)
  const kr = Number.parseInt(e.color.slice(1, 3), 16)
  const kg = Number.parseInt(e.color.slice(3, 5), 16)
  const kb = Number.parseInt(e.color.slice(5, 7), 16)
  const thr = e.similarity * 441
  const soft = Math.max(1, e.blend * 441)
  for (let i = 0; i < img.data.length; i += 4) {
    const d = Math.hypot(img.data[i]! - kr, img.data[i + 1]! - kg, img.data[i + 2]! - kb)
    if (d < thr) img.data[i + 3] = 0
    else if (d < thr + soft) img.data[i + 3] = Math.round(((d - thr) / soft) * 255)
  }
  ctx.putImageData(img, 0, 0)
  return keyCanvas
}

let layerCanvas: HTMLCanvasElement | null = null
let maskCanvas: HTMLCanvasElement | null = null

/**
 * Desenha a camada num canvas auxiliar do tamanho ajustado (w×h) e recorta
 * com as máscaras — mesma geometria e mesmo sigma de maskSource (exportação).
 * A borda suave é desenhada com margem para não esmaecer nas bordas do
 * quadro (o gblur do FFmpeg replica as bordas).
 */
function maskedLayer(w: number, h: number, masks: MaskEffect[], draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): HTMLCanvasElement {
  const k = Math.min(1, 1920 / Math.max(w, h))
  const lw = Math.max(2, Math.round(w * k))
  const lh = Math.max(2, Math.round(h * k))
  layerCanvas ??= document.createElement('canvas')
  maskCanvas ??= document.createElement('canvas')
  layerCanvas.width = lw
  layerCanvas.height = lh
  const lc = layerCanvas.getContext('2d')!
  lc.save()
  lc.translate(lw / 2, lh / 2)
  draw(lc, lw, lh)
  lc.restore()
  for (const m of masks) {
    const g = maskGeometry(m, lw, lh)
    const pad = Math.ceil(g.sigma * 3) + 1
    maskCanvas.width = lw + 2 * pad
    maskCanvas.height = lh + 2 * pad
    const mc = maskCanvas.getContext('2d')!
    mc.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
    const shape = () => {
      mc.beginPath()
      if (m.shape === 'ellipse') mc.ellipse(pad + g.cx, pad + g.cy, g.rx, g.ry, 0, 0, Math.PI * 2)
      else {
        // lados encostados na borda continuam pela margem (equivale à replicação de borda)
        const x0 = g.cx - g.rx <= 0 ? 0 : pad + g.cx - g.rx
        const y0 = g.cy - g.ry <= 0 ? 0 : pad + g.cy - g.ry
        const x1 = g.cx + g.rx >= lw ? lw + 2 * pad : pad + g.cx + g.rx
        const y1 = g.cy + g.ry >= lh ? lh + 2 * pad : pad + g.cy + g.ry
        mc.rect(x0, y0, x1 - x0, y1 - y0)
      }
      mc.fill()
    }
    mc.fillStyle = '#fff'
    if (m.invert) {
      mc.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
      mc.globalCompositeOperation = 'destination-out'
    }
    mc.filter = g.sigma > 0.05 ? `blur(${g.sigma}px)` : 'none'
    shape()
    mc.filter = 'none'
    mc.globalCompositeOperation = 'source-over'
    lc.globalCompositeOperation = 'destination-in'
    lc.drawImage(maskCanvas, pad, pad, lw, lh, 0, 0, lw, lh)
    lc.globalCompositeOperation = 'source-over'
  }
  return layerCanvas
}

function drawText(ctx: CanvasRenderingContext2D, clip: Extract<Clip, { type: 'text' }>, W: number, H: number) {
  const st = clip.style
  const px = fontPx(st.fontSize, W, H)
  const lines = wrapText(clip.text, px, st.fontWeight, W * TEXT_MAX_WIDTH_RATIO, st.fontFamily)
  ctx.font = `${st.fontWeight} ${px}px "${st.fontFamily}"`
  ctx.textBaseline = 'middle'
  const lh = px * LINE_HEIGHT
  const widths = lines.map((l) => ctx.measureText(l).width)
  const blockW = Math.max(...widths, 1)
  const blockH = lh * lines.length
  if (st.background) {
    const pad = px * 0.35
    ctx.fillStyle = st.background
    ctx.fillRect(-blockW / 2 - pad, -blockH / 2 - pad, blockW + 2 * pad, blockH + 2 * pad)
  }
  lines.forEach((line, i) => {
    const w = widths[i]!
    const x = st.align === 'left' ? -blockW / 2 : st.align === 'right' ? blockW / 2 - w : -w / 2
    const y = -blockH / 2 + lh * (i + 0.5)
    if (st.shadow > 0) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowOffsetX = ctx.shadowOffsetY = (st.shadow * H) / 1080
    }
    if (st.outlineWidth > 0) {
      ctx.lineJoin = 'round'
      ctx.lineWidth = ((st.outlineWidth * H) / 1080) * 2
      ctx.strokeStyle = st.outlineColor
      ctx.strokeText(line, x, y)
    }
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = st.color
    ctx.fillText(line, x, y)
  })
}

export function drawCaptions(ctx: CanvasRenderingContext2D, doc: TimelineDoc, t: number, W: number, H: number) {
  if (!doc.captions.burnIn) return
  const style = (doc.captionStyles.find((s) => s.id === doc.captions.styleId) ?? doc.captionStyles[0]) as CaptionStyle | undefined
  if (!style) return
  const seg = doc.captions.segments.find((s) => t >= s.start && t < s.end)
  if (!seg) return
  const px = fontPx(style.fontSize, W, H)
  const transform = (s: string) => (style.uppercase ? s.toLocaleUpperCase('pt-BR') : s)
  ctx.save()
  ctx.font = `${style.fontWeight} ${px}px "${style.fontFamily}"`
  ctx.textBaseline = 'middle'
  const maxW = W * (1 - 2 * style.marginX)
  const useWords = !!seg.words && seg.words.length > 0 && style.highlightWords
  const words = useWords ? seg.words!.map((w) => transform(w.text)) : transform(seg.text).split(/\s+/).filter(Boolean)
  const activeIdx = useWords ? seg.words!.findIndex((w, i) => t >= w.start && t < (seg.words![i + 1]?.start ?? seg.end)) : -1
  // mesmas quebras do gerador ASS da exportação
  const lines = wrapCaptionTokens(words, px, style.fontWeight, maxW, style.fontFamily).map((r) => r.map((i) => ({ w: words[i]!, i })))
  const lh = px * FONT_LINE_EM
  const cy = style.positionY * H
  lines.forEach((line, li) => {
    const text = line.map((x) => x.w).join(' ')
    const total = ctx.measureText(text).width
    let x = W / 2 - total / 2
    const y = cy - (lh * (lines.length - 1)) / 2 + li * lh
    if (style.background) {
      ctx.fillStyle = style.background
      ctx.fillRect(x - px * 0.2, y - lh / 2, total + px * 0.4, lh)
    }
    for (const { w, i } of line) {
      const ww = ctx.measureText(w).width
      if (style.outlineWidth > 0 && !style.background) {
        ctx.lineJoin = 'round'
        ctx.lineWidth = ((style.outlineWidth * H) / 1080) * 2
        ctx.strokeStyle = style.outlineColor
        ctx.strokeText(w, x, y)
      }
      ctx.fillStyle = i === activeIdx ? style.highlightColor : style.color
      ctx.fillText(w, x, y)
      x += ww + ctx.measureText(' ').width
    }
  })
  ctx.restore()
}

/** Desenha o quadro do tempo `t` (flicks) no canvas de tamanho W×H. */
/** Mídia + efeitos de imagem centrados na origem atual, no tamanho bw×bh. */
function drawMedia(ctx: CanvasRenderingContext2D, img: CanvasImageSource, effects: Effect[], bw: number, bh: number, res: number, alpha: number) {
  ctx.filter = cssFilter(effects, res)
  try {
    ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh)
  } catch {
    // frame ainda não decodificado
  }
  ctx.filter = 'none'
  for (const e of effects) {
    if (e.type === 'temperature') {
      const warm = (6500 - e.kelvin) / 4500
      ctx.globalCompositeOperation = 'soft-light'
      ctx.fillStyle = warm > 0 ? `rgba(255,140,40,${Math.min(0.6, warm * 0.5)})` : `rgba(60,130,255,${Math.min(0.6, -warm * 0.5)})`
      ctx.fillRect(-bw / 2, -bh / 2, bw, bh)
      ctx.globalCompositeOperation = 'source-over'
    }
    if (e.type === 'vignette' && e.strength > 0) {
      const g = ctx.createRadialGradient(0, 0, Math.min(bw, bh) * 0.25, 0, 0, Math.hypot(bw, bh) / 2)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(1, `rgba(0,0,0,${0.85 * e.strength})`)
      ctx.fillStyle = g
      ctx.fillRect(-bw / 2, -bh / 2, bw, bh)
    }
    if (e.type === 'grain' && e.amount > 0) {
      ctx.globalAlpha = alpha * e.amount * 0.35
      ctx.globalCompositeOperation = 'overlay'
      const pattern = ctx.createPattern(noiseCanvas(), 'repeat')
      if (pattern) {
        ctx.fillStyle = pattern
        ctx.fillRect(-bw / 2, -bh / 2, bw, bh)
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = alpha
    }
  }
}

export function composeFrame(
  ctx: CanvasRenderingContext2D,
  doc: TimelineDoc,
  t: number,
  W: number,
  H: number,
  sources: (clip: Clip) => MediaSource | null,
  assetDurations: Record<string, number>,
) {
  ctx.save()
  ctx.fillStyle = doc.settings.background
  ctx.fillRect(0, 0, W, H)
  const layers = activeVisualLayers(doc, t, assetDurations)
  const res = H / 1080
  for (const layer of layers) {
    const { clip, state } = layer
    if (state.opacity <= 0.001) continue
    ctx.save()
    ctx.globalAlpha = state.opacity
    ctx.translate(state.x * W, state.y * H)
    ctx.rotate((state.rotation * Math.PI) / 180)
    if (clip.type === 'text') {
      ctx.scale(state.scale, state.scale)
      drawText(ctx, clip, W, H)
    } else if (clip.type === 'color') {
      const masks = masksOf(clip.effects)
      if (masks.length) {
        const layer = maskedLayer(W, H, masks, (c, w, h) => {
          c.fillStyle = clip.color
          c.fillRect(-w / 2, -h / 2, w, h)
        })
        ctx.drawImage(layer, (-W * state.scale) / 2, (-H * state.scale) / 2, W * state.scale, H * state.scale)
      } else {
        ctx.scale(state.scale, state.scale)
        ctx.fillStyle = clip.color
        ctx.fillRect(-W / 2, -H / 2, W, H)
      }
    } else {
      const src = sources(clip)
      if (src?.el && src.width && src.height) {
        const s = clip.fit === 'cover' ? Math.max(W / src.width, H / src.height) : Math.min(W / src.width, H / src.height)
        const bw = src.width * s * state.scale
        const bh = src.height * s * state.scale
        const key = clip.effects.find((e): e is Extract<Effect, { type: 'chromakey' }> => e.type === 'chromakey')
        const img: CanvasImageSource = key ? chromaKeyed(src.el, src.width, src.height, key) : src.el
        const masks = masksOf(clip.effects)
        if (masks.length) {
          const layer = maskedLayer(src.width * s, src.height * s, masks, (c, w, h) => drawMedia(c, img, clip.effects, w, h, res, 1))
          ctx.drawImage(layer, -bw / 2, -bh / 2, bw, bh)
        } else {
          drawMedia(ctx, img, clip.effects, bw, bh, res, state.opacity)
        }
      } else {
        ctx.fillStyle = '#1f2229'
        ctx.fillRect(-W / 4, -H / 12, W / 2, H / 6)
        ctx.fillStyle = '#a1a7b2'
        ctx.font = `${Math.round(24 * res)}px Inter`
        ctx.textAlign = 'center'
        ctx.fillText('Carregando mídia…', 0, 8 * res)
      }
    }
    ctx.restore()
  }
  drawCaptions(ctx, doc, t, W, H)
  ctx.restore()
}

export const flicksToSec = (f: number) => f / FLICKS_PER_SECOND
