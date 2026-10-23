import type { CaptionSegment, Scene, TimelineDoc } from '@orion/shared'
import { produce } from 'immer'
import { clipEnd } from './evaluate.ts'
import { makeColorClip, makeMediaClip, newId } from './ops.ts'
import { FLICKS_PER_SECOND, quantize, secondsToFlicks } from './time.ts'

/** Ritmo médio de narração em português (palavras por segundo, velocidade 1×). */
export const PT_BR_WORDS_PER_SECOND = 2.5

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

export function estimateNarrationSeconds(text: string, speed = 1): number {
  const words = countWords(text)
  const pauses = (text.match(/[.!?…]/g) ?? []).length * 0.3 + (text.match(/[,;:]/g) ?? []).length * 0.12
  return Math.max(1, words / (PT_BR_WORDS_PER_SECOND * speed) + pauses)
}

/** Divide em frases preservando pontuação; frases longas são quebradas em vírgulas. */
export function splitSentences(text: string, maxChars = 400): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const raw = normalized.match(/[^.!?…]+[.!?…]+["”']?|[^.!?…]+$/g) ?? [normalized]
  const out: string[] = []
  for (const s of raw.map((x) => x.trim()).filter(Boolean)) {
    if (s.length <= maxChars) {
      out.push(s)
      continue
    }
    let buf = ''
    for (const part of s.split(/(?<=[,;:])\s+/)) {
      if ((buf + ' ' + part).trim().length > maxChars && buf) {
        out.push(buf.trim())
        buf = part
      } else buf = `${buf} ${part}`
    }
    if (buf.trim()) {
      // ainda grande demais: corta por palavras
      let rest = buf.trim()
      while (rest.length > maxChars) {
        const cut = rest.lastIndexOf(' ', maxChars)
        const i = cut > 0 ? cut : maxChars
        out.push(rest.slice(0, i).trim())
        rest = rest.slice(i).trim()
      }
      if (rest) out.push(rest)
    }
  }
  return out
}

export interface StoryboardOptions {
  /** duração máxima de uma cena (s); cenas maiores são divididas */
  maxSceneSeconds: number
  visualStyle: string
  characterIds?: string[]
  characterPrompts?: string[]
}

/** Roteiro longo → cenas com narração, prompt visual e duração estimada. */
export function scriptToScenes(script: string, opts: StoryboardOptions): Scene[] {
  const paragraphs = script
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const scenes: Scene[] = []
  for (const p of paragraphs) {
    const sentences = splitSentences(p)
    let group: string[] = []
    const flush = () => {
      if (!group.length) return
      const narration = group.join(' ')
      const secs = estimateNarrationSeconds(narration)
      const n = scenes.length + 1
      const title = narration.split(/\s+/).slice(0, 6).join(' ').replace(/[.,;:!?…]+$/, '')
      const characters = opts.characterPrompts?.length ? ` Personagens: ${opts.characterPrompts.join(' | ')}.` : ''
      scenes.push({
        key: `cena-${String(n).padStart(3, '0')}`,
        title,
        narration,
        visualPrompt: `${opts.visualStyle}. Cena que ilustra: ${narration}${characters}`.slice(0, 4000),
        estimatedDuration: secondsToFlicks(Math.round(secs * 10) / 10),
        characterIds: opts.characterIds ?? [],
        status: 'draft',
      })
      group = []
    }
    for (const s of sentences) {
      const candidate = [...group, s].join(' ')
      if (group.length && estimateNarrationSeconds(candidate) > opts.maxSceneSeconds) flush()
      group.push(s)
    }
    flush()
  }
  return scenes
}

/**
 * Planeja tomadas de geração para uma cena respeitando as durações aceitas
 * pelo provedor. Ex.: cena de 13 s com durações {4,6,8} → [8, 6] (14 s, o
 * excedente é cortado na timeline).
 */
export function planShots(sceneSeconds: number, allowed: number[]): number[] {
  const opts = [...new Set(allowed)].filter((x) => x > 0).sort((a, b) => b - a)
  if (!opts.length) throw new RangeError('provedor sem durações suportadas')
  const max = opts[0]!
  const shots: number[] = []
  let remaining = sceneSeconds
  while (remaining > max) {
    shots.push(max)
    remaining -= max
  }
  // menor duração que cobre o restante
  const fit = [...opts].reverse().find((o) => o >= remaining - 1e-9) ?? max
  shots.push(fit)
  return shots
}

export interface SceneMedia {
  sceneKey: string
  visual?: { assetId: string; type: 'video' | 'image'; durationFlicks: number | null }
  narration?: { assetId: string; durationFlicks: number; captions?: CaptionSegment[] }
}

/**
 * Monta as cenas na timeline: visual na trilha principal, narração na trilha
 * de voz e legendas vinculadas. A duração de cada cena = max(narração,
 * estimativa). Visual mais curto que a cena é estendido com zoom lento
 * (imagem) ou mantém o último frame (vídeo) — o usuário revisa depois.
 */
export function assembleScenes(doc: TimelineDoc, scenes: Scene[], media: SceneMedia[]): TimelineDoc {
  const fps = doc.settings.fps
  const byKey = new Map(media.map((m) => [m.sceneKey, m]))
  return produce(doc, (d) => {
    const main = d.tracks.find((t) => t.kind === 'video')!
    const voice = d.tracks.find((t) => t.kind === 'voice')!
    let cursor = main.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
    for (const scene of scenes) {
      const m = byKey.get(scene.key)
      const narrDur = m?.narration ? quantize(m.narration.durationFlicks, fps, 'ceil') : 0
      const dur = Math.max(narrDur, quantize(scene.estimatedDuration, fps, 'round'), quantize(FLICKS_PER_SECOND, fps))
      const visual = m?.visual
        ? makeMediaClip(m.visual.type, m.visual.assetId, cursor, dur, scene.title)
        : { ...makeColorClip('#1B1E24', cursor, dur), name: `Pendente: ${scene.title}` }
      visual.sceneKey = scene.key
      if (cursor > 0) visual.transitionIn = { type: 'dissolve', duration: quantize(secondsToFlicks(0.4), fps) }
      if (m?.visual?.type === 'image') {
        const v = visual as typeof visual & { keyframes: typeof visual.keyframes }
        v.keyframes = [
          { id: newId(), property: 'scale', time: 0, value: 1, easing: 'linear' },
          { id: newId(), property: 'scale', time: dur, value: 1.08, easing: 'linear' },
        ]
      }
      main.clips.push(visual)
      if (m?.narration) {
        const nclip = makeMediaClip('audio', m.narration.assetId, cursor, Math.min(dur, quantize(m.narration.durationFlicks, fps, 'floor')), `Narração — ${scene.title}`)
        nclip.sceneKey = scene.key
        voice.clips.push(nclip)
        for (const c of m.narration.captions ?? []) {
          d.captions.segments.push({
            ...c,
            id: newId(),
            start: c.start + cursor,
            end: Math.min(c.end + cursor, cursor + dur),
            words: c.words?.map((w) => ({ ...w, start: w.start + cursor, end: w.end + cursor })),
            linkedClipId: nclip.id,
          })
        }
      }
      cursor += dur
    }
    main.clips.sort((a, b) => a.start - b.start)
    voice.clips.sort((a, b) => a.start - b.start)
    d.captions.segments.sort((a, b) => a.start - b.start)
    const existing = new Set(d.scenes.map((s) => s.key))
    for (const s of scenes) if (!existing.has(s.key)) d.scenes.push(s)
  })
}

/**
 * Converte alinhamento por caractere (ElevenLabs) em legendas com palavras.
 * Só é chamado quando o provedor devolve timestamps reais.
 */
export function captionsFromCharAlignment(
  chars: string[],
  starts: number[],
  ends: number[],
  maxWordsPerSegment = 7,
): CaptionSegment[] {
  const words: Array<{ text: string; start: number; end: number }> = []
  let buf = ''
  let ws = 0
  let we = 0
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (/\s/.test(ch)) {
      if (buf) words.push({ text: buf, start: ws, end: we })
      buf = ''
      continue
    }
    if (!buf) ws = starts[i] ?? 0
    buf += ch
    we = ends[i] ?? ws
  }
  if (buf) words.push({ text: buf, start: ws, end: we })
  return wordsToSegments(words.map((w) => ({ text: w.text, start: secondsToFlicks(w.start), end: secondsToFlicks(w.end) })), maxWordsPerSegment)
}

export function wordsToSegments(
  words: Array<{ text: string; start: number; end: number }>,
  maxWordsPerSegment = 7,
): CaptionSegment[] {
  const segs: CaptionSegment[] = []
  let group: typeof words = []
  const flush = () => {
    if (!group.length) return
    segs.push({
      id: newId(),
      start: group[0]!.start,
      end: Math.max(group[group.length - 1]!.end, group[0]!.start + 1),
      text: group.map((w) => w.text).join(' '),
      words: group.map((w) => ({ ...w })),
    })
    group = []
  }
  for (const w of words) {
    group.push(w)
    if (group.length >= maxWordsPerSegment || /[.!?…]$/.test(w.text)) flush()
  }
  flush()
  return segs
}
