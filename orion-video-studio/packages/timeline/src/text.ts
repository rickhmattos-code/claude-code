import { FONT_METRICS, METRIC_CHARS } from './font-metrics.ts'

/**
 * Layout de texto compartilhado entre prévia e exportação. A quebra de
 * linhas é decidida aqui (estimativa de largura média por glifo da Inter),
 * e ambos os renderizadores usam exatamente as mesmas linhas.
 */

/** Tamanho de fonte em pixels: referência 1080 px no lado menor do quadro. */
export function fontPx(fontSize: number, width: number, height: number): number {
  return Math.max(1, Math.round((fontSize * Math.min(width, height)) / 1080))
}

const INDEX = new Map<string, number>([...METRIC_CHARS].map((c, i) => [c, i]))

/** Largura do texto em px usando as métricas reais da fonte (sem kerning). */
export function estimateTextWidth(text: string, px: number, weight: number, family = 'Inter'): number {
  const table = FONT_METRICS[`${family}|${weight}`] ?? FONT_METRICS['Inter|700']!
  const fallback = table[INDEX.get('n')!]!
  let w = 0
  for (const ch of text) {
    const i = INDEX.get(ch)
    w += i === undefined ? fallback : table[i]!
  }
  return (w / 1000) * px
}

/** Quebra o texto em linhas com largura máxima `maxWidth` (px). Respeita \n. */
export function wrapText(text: string, px: number, weight: number, maxWidth: number, family = 'Inter'): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (line && estimateTextWidth(candidate, px, weight, family) > maxWidth) {
        out.push(line)
        line = word
      } else line = candidate
    }
    if (line) out.push(line)
  }
  return out
}

export const TEXT_MAX_WIDTH_RATIO = 0.86
export const LINE_HEIGHT = 1.18
/** (ascender + descender) / em da Inter (todas as variantes): 969 + 242 = 1211/1000 */
export const FONT_LINE_EM = 1.211

/**
 * Linhas de uma legenda como listas de índices de palavras (para destacar a
 * palavra falada). Usado pela prévia e pelo gerador ASS — mesmas quebras.
 */
export function wrapCaptionTokens(tokens: string[], px: number, weight: number, maxWidth: number, family = 'Inter'): number[][] {
  const lines = wrapText(tokens.join(' '), px, weight, maxWidth, family)
  const out: number[][] = []
  let i = 0
  for (const line of lines) {
    const n = line.split(/\s+/).filter(Boolean).length
    out.push(Array.from({ length: n }, (_, k) => i + k))
    i += n
  }
  return out
}
