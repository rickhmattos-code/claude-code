/** Avaliador mínimo do subconjunto de expressões FFmpeg gerado por expr.ts (somente testes). */
export function evalFfmpegExpr(src: string, vars: Record<string, number>): number {
  let i = 0
  const peek = () => src[i]
  const skip = () => {
    while (src[i] === ' ') i++
  }
  function expr(): number {
    let v = term()
    skip()
    while (peek() === '+' || peek() === '-') {
      const op = src[i++]
      const r = term()
      v = op === '+' ? v + r : v - r
      skip()
    }
    return v
  }
  function term(): number {
    let v = factor()
    skip()
    while (peek() === '*' || peek() === '/') {
      const op = src[i++]
      const r = factor()
      v = op === '*' ? v * r : v / r
      skip()
    }
    return v
  }
  function args(): number[] {
    const out: number[] = []
    i++ // (
    out.push(expr())
    while (peek() === ',') {
      i++
      out.push(expr())
    }
    if (src[i++] !== ')') throw new SyntaxError(`esperado ) em ${i}`)
    return out
  }
  function factor(): number {
    skip()
    const c = peek()
    if (c === '-') {
      i++
      return -factor()
    }
    if (c === '(') {
      i++
      const v = expr()
      if (src[i++] !== ')') throw new SyntaxError(`esperado ) em ${i}`)
      return v
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i))
    if (num) {
      i += num[0].length
      return Number(num[0])
    }
    const id = /^[a-zA-Z_]\w*/.exec(src.slice(i))
    if (!id) throw new SyntaxError(`token inesperado em ${i}: ${src.slice(i, i + 10)}`)
    i += id[0].length
    const name = id[0]
    if (peek() === '(') {
      if (name === 'if') {
        // avaliação ansiosa é suficiente (sem efeitos colaterais)
        const [c0, a, b] = args()
        return c0 !== 0 ? a! : (b ?? 0)
      }
      const a = args()
      if (name === 'lt') return a[0]! < a[1]! ? 1 : 0
      if (name === 'gte') return a[0]! >= a[1]! ? 1 : 0
      if (name === 'clip') return Math.min(Math.max(a[0]!, a[1]!), a[2]!)
      if (name === 'between') return a[0]! >= a[1]! && a[0]! <= a[2]! ? 1 : 0
      throw new SyntaxError(`função desconhecida ${name}`)
    }
    if (!(name in vars)) throw new SyntaxError(`variável desconhecida ${name}`)
    return vars[name]!
  }
  const v = expr()
  if (i !== src.length) throw new SyntaxError(`sobra em ${i}: ${src.slice(i)}`)
  return v
}
