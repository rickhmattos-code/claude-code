import type { Piecewise, SegEasing } from './evaluate.ts'

/**
 * Conversão de funções por partes em expressões do avaliador do FFmpeg
 * (libavutil/eval). Usa apenas: números, a variável de tempo, + - * /,
 * if(), lt(), clip(). As mesmas funções por partes alimentam a prévia,
 * garantindo coerência (ver test/expr.test.ts).
 */

export function num(v: number): string {
  if (!Number.isFinite(v)) throw new RangeError('valor não finito em expressão')
  const s = v.toFixed(6).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s.startsWith('-') ? `(${s})` : s
}

function easeExpr(u: string, easing: SegEasing): string {
  switch (easing) {
    case 'linear':
      return u
    case 'hold':
      return '0'
    case 'easeInOut':
      return `(${u})*(${u})*(3-2*(${u}))`
    case 'easeOut':
      return `(1-(1-(${u}))*(1-(${u})))`
  }
}

/** `T` é o texto da variável de tempo local do clipe, ex.: "(t-2.5)". */
export function piecewiseExpr(p: Piecewise, T: string): string {
  if (p.segments.length === 0) return num(p.before)
  let expr = num(p.after)
  for (let i = p.segments.length - 1; i >= 0; i--) {
    const s = p.segments[i]!
    const span = s.t1 - s.t0
    const u = span > 0 ? `clip((${T}-${num(s.t0)})/${num(span)},0,1)` : '1'
    const val = `(${num(s.v0)}+${num(s.v1 - s.v0)}*${easeExpr(u, s.easing)})`
    expr = `if(lt(${T},${num(s.t1)}),if(lt(${T},${num(s.t0)}),${num(s.v0)},${val}),${expr})`
  }
  const first = p.segments[0]!
  return `if(lt(${T},${num(first.t0)}),${num(p.before)},${expr})`
}

export function productExpr(parts: string[]): string {
  const nonTrivial = parts.filter((p) => p !== '1')
  if (nonTrivial.length === 0) return '1'
  return nonTrivial.map((p) => `(${p})`).join('*')
}

export function sumExpr(parts: string[]): string {
  const nonTrivial = parts.filter((p) => p !== '0')
  if (nonTrivial.length === 0) return '0'
  return nonTrivial.map((p) => `(${p})`).join('+')
}
