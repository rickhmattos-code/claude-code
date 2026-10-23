import type { TimelineDoc } from '@orion/shared'
import { audibleTracks, clipEnd, docDuration, isMediaClip } from './evaluate.ts'
import { FLICKS_PER_SECOND, quantize } from './time.ts'

/**
 * Sugestão de cortes curtos a partir de um vídeo longo.
 *
 * Heurística transparente (sem IA): janelas alinhadas às frases da
 * transcrição, pontuadas por cobertura de fala, ritmo, gancho na primeira
 * frase e energia do áudio. Cada sugestão traz os motivos da nota para o
 * usuário decidir. Não promete "viralizar": é um ponto de partida editável.
 */

export interface PeakData {
  peaksPerSecond: number
  peaks: number[]
}

export interface Highlight {
  start: number
  end: number
  /** 0–100 */
  score: number
  reasons: string[]
  excerpt: string
}

export interface HighlightOptions {
  minSeconds?: number
  maxSeconds?: number
  targetSeconds?: number
  count?: number
  /** energia normalizada (0–1) por segundo da timeline, ver energyCurve */
  energy?: number[]
}

/**
 * Energia do mix por segundo da timeline: máximo dos picos das trilhas
 * audíveis, ponderado pelo volume do clipe e da trilha, normalizado a 0–1.
 */
export function energyCurve(doc: TimelineDoc, peaksByAsset: Map<string, PeakData>): number[] {
  const seconds = Math.ceil(docDuration(doc) / FLICKS_PER_SECOND)
  const out = new Array<number>(seconds).fill(0)
  for (const track of audibleTracks(doc)) {
    for (const clip of track.clips) {
      if (!isMediaClip(clip) || clip.type === 'image') continue
      const data = peaksByAsset.get(clip.assetId)
      if (!data || data.peaks.length === 0) continue
      const gain = clip.volume * track.volume
      const s0 = Math.floor(clip.start / FLICKS_PER_SECOND)
      const s1 = Math.ceil(clipEnd(clip) / FLICKS_PER_SECOND)
      for (let s = s0; s < Math.min(s1, seconds); s++) {
        // segundo da timeline → intervalo na mídia de origem
        const a = clip.sourceIn + Math.max(0, s * FLICKS_PER_SECOND - clip.start) * clip.speed
        const b = clip.sourceIn + Math.min(clip.duration, (s + 1) * FLICKS_PER_SECOND - clip.start) * clip.speed
        const i0 = Math.floor((a / FLICKS_PER_SECOND) * data.peaksPerSecond)
        const i1 = Math.max(i0 + 1, Math.ceil((b / FLICKS_PER_SECOND) * data.peaksPerSecond))
        let sum = 0
        let n = 0
        for (let i = i0; i < Math.min(i1, data.peaks.length); i++) {
          sum += data.peaks[i]!
          n++
        }
        if (n) out[s] = Math.max(out[s]!, (sum / n) * gain)
      }
    }
  }
  const max = Math.max(0, ...out)
  return max > 0 ? out.map((v) => v / max) : out
}

const HOOK_PATTERNS = [
  /\?/,
  /!/,
  /\d/,
  /\b(como|por que|porque|segredo|erro|nunca|sempre|dica|aten[cç][aã]o|imagine|voc[eê] sabia|o maior|o melhor|o pior|ningu[eé]m|verdade|cuidado)\b/i,
]

export function suggestHighlights(doc: TimelineDoc, opts: HighlightOptions = {}): Highlight[] {
  const S = FLICKS_PER_SECOND
  const min = (opts.minSeconds ?? 15) * S
  const max = (opts.maxSeconds ?? 60) * S
  const target = (opts.targetSeconds ?? 35) * S
  const count = opts.count ?? 3
  const segs = doc.captions.segments
  if (segs.length === 0) return []
  const candidates: Highlight[] = []
  for (let i = 0; i < segs.length; i++) {
    let speech = 0
    let words = 0
    for (let j = i; j < segs.length; j++) {
      const sj = segs[j]!
      speech += sj.end - sj.start
      words += sj.text.split(/\s+/).filter(Boolean).length
      const start = segs[i]!.start
      const end = sj.end
      const dur = end - start
      if (dur > max) break
      if (dur < min) continue
      const reasons: string[] = []
      const coverage = Math.min(1, speech / dur)
      const wps = words / (dur / S)
      // ritmo ideal de fala em vídeos curtos ~2,3–3,2 palavras/s
      const pace = Math.max(0, 1 - Math.abs(wps - 2.7) / 2.7)
      const first = segs[i]!.text
      const hook = HOOK_PATTERNS.filter((p) => p.test(first)).length / 2
      const hookScore = Math.min(1, hook)
      let energy = 0.5
      if (opts.energy && opts.energy.length) {
        const a = Math.floor(start / S)
        const b = Math.max(a + 1, Math.ceil(end / S))
        const slice = opts.energy.slice(a, b)
        energy = slice.reduce((x, y) => x + y, 0) / Math.max(1, slice.length)
      }
      const fit = 1 - Math.min(1, Math.abs(dur - target) / target)
      const score = opts.energy?.length
        ? 0.35 * coverage + 0.2 * pace + 0.2 * hookScore + 0.15 * energy + 0.1 * fit
        : 0.4 * coverage + 0.25 * pace + 0.25 * hookScore + 0.1 * fit
      if (coverage > 0.8) reasons.push('fala contínua')
      if (pace > 0.7) reasons.push(`ritmo de ${wps.toFixed(1).replace('.', ',')} palavras/s`)
      if (hookScore >= 0.5) reasons.push('começa com gancho (pergunta, número ou palavra forte)')
      if (opts.energy?.length && energy > 0.6) reasons.push('áudio com mais energia')
      candidates.push({
        start,
        end,
        score: Math.round(score * 100),
        reasons,
        excerpt: segs
          .slice(i, j + 1)
          .map((s) => s.text)
          .join(' ')
          .slice(0, 160),
      })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start)
  const picked: Highlight[] = []
  for (const c of candidates) {
    if (picked.length >= count) break
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue
    picked.push({ ...c, start: quantize(c.start, doc.settings.fps, 'floor'), end: quantize(c.end, doc.settings.fps, 'ceil') })
  }
  return picked.sort((a, b) => a.start - b.start)
}
