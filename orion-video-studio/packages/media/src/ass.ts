import type { CaptionSegment, CaptionStyle } from '@orion/shared'
import { FLICKS_PER_SECOND, FONT_LINE_EM, fontPx, wrapCaptionTokens } from '@orion/timeline'

/**
 * Gera legendas ASS para gravação no vídeo (libass). Posicionamento por
 * \an5\pos (centro do bloco em positionY), margens laterais = marginX.
 * Destaque palavra a palavra só quando o segmento traz `words` (alinhamento
 * real do provedor/alinhador) e o estilo pede highlightWords.
 */

export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace('#', '')
  const r = h.slice(0, 2)
  const g = h.slice(2, 4)
  const b = h.slice(4, 6)
  const a = h.length >= 8 ? 255 - Number.parseInt(h.slice(6, 8), 16) : alpha
  return `&H${a.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase()
}

function assTime(flicks: number): string {
  const cs = Math.max(0, Math.round((flicks * 100) / FLICKS_PER_SECOND))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

function escapeAss(text: string): string {
  // remove chaves (override tags) e normaliza quebras
  return text.replace(/[{}]/g, '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\N')
}

export interface AssOptions {
  width: number
  height: number
  /** subtrai deste tempo (início do bloco de renderização) */
  offset: number
  /** limita ao intervalo [offset, offset + window) */
  window: number
}

export function buildAss(segments: CaptionSegment[], style: CaptionStyle, opts: AssOptions): string {
  const { width: W, height: H } = opts
  // libass dimensiona a fonte pela altura de linha (ascender+descender); a prévia
  // usa px de em (CSS). Convertemos para que o glifo tenha o mesmo tamanho.
  const px = fontPx(style.fontSize, W, H)
  const size = Math.round(px * FONT_LINE_EM)
  const marginX = Math.round(style.marginX * W)
  const boxed = style.background !== null
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    // quebras calculadas aqui (mesmo algoritmo da prévia) e inseridas como \\N
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Orion,${style.fontFamily},${size},${assColor(style.color)},${assColor(style.highlightColor)},${assColor(boxed ? style.background! : style.outlineColor)},${assColor('#000000', 0x60)},${style.fontWeight >= 600 ? -1 : 0},0,0,0,100,100,0,0,${boxed ? 3 : 1},${boxed ? Math.max(4, Math.round(px * 0.2)) : Math.round((style.outlineWidth * H) / 1080)},${Math.round((style.shadow * H) / 1080)},5,${marginX},${marginX},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const lines: string[] = []
  const pos = `{\\an5\\pos(${Math.round(W / 2)},${Math.round(style.positionY * H)})}`
  const hi = assColor(style.highlightColor)
  const base = assColor(style.color)
  const winStart = opts.offset
  const winEnd = opts.offset + opts.window
  const maxW = W * (1 - 2 * style.marginX)
  const display = (t: string) => (style.uppercase ? t.toLocaleUpperCase('pt-BR') : t)
  for (const seg of segments) {
    if (seg.end <= winStart || seg.start >= winEnd) continue
    const useWords = style.highlightWords && !!seg.words && seg.words.length > 0
    const tokens = useWords ? seg.words!.map((w) => display(w.text)) : display(seg.text).split(/\s+/).filter(Boolean)
    const rows = wrapCaptionTokens(tokens, px, style.fontWeight, maxW, style.fontFamily)
    const render = (active: number) => rows.map((r) => r.map((i) => (i === active ? `{\\1c${hi}}${escapeAss(tokens[i]!)}{\\1c${base}}` : escapeAss(tokens[i]!))).join(' ')).join('\\N')
    if (useWords) {
      seg.words!.forEach((w, i) => {
        const s = Math.max(i === 0 ? seg.start : w.start, winStart)
        const nextStart = seg.words![i + 1]?.start ?? seg.end
        const e = Math.min(Math.max(w.end, nextStart), seg.end, winEnd)
        if (e <= s) return
        lines.push(`Dialogue: 0,${assTime(s - winStart)},${assTime(e - winStart)},Orion,,0,0,0,,${pos}${render(i)}`)
      })
    } else {
      const s = Math.max(seg.start, winStart)
      const e = Math.min(seg.end, winEnd)
      lines.push(`Dialogue: 0,${assTime(s - winStart)},${assTime(e - winStart)},Orion,,0,0,0,,${pos}${render(-1)}`)
    }
  }
  return `${[...header, ...lines].join('\n')}\n`
}
