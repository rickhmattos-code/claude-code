import type { CaptionSegment } from '@orion/shared'
import { newId } from './ops.ts'
import { formatSubtitleTime, parseSubtitleTime } from './time.ts'

/** Importação/exportação SRT e WebVTT (UTF-8). */

export function toSrt(segments: CaptionSegment[]): string {
  return (
    [...segments]
      .sort((a, b) => a.start - b.start)
      .map(
        (s, i) =>
          `${i + 1}\n${formatSubtitleTime(s.start, ',')} --> ${formatSubtitleTime(s.end, ',')}\n${s.speaker ? `${s.speaker}: ` : ''}${s.text}`,
      )
      .join('\n\n') + '\n'
  )
}

export function toVtt(segments: CaptionSegment[]): string {
  const body = [...segments]
    .sort((a, b) => a.start - b.start)
    .map(
      (s) =>
        `${formatSubtitleTime(s.start, '.')} --> ${formatSubtitleTime(s.end, '.')}\n${s.speaker ? `<v ${s.speaker}>` : ''}${s.text}`,
    )
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}

const ARROW = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/

/** Aceita SRT ou VTT. Remove tags simples e cabeçalhos; ignora blocos NOTE/STYLE. */
export function parseSubtitles(text: string): CaptionSegment[] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = clean.split(/\n{2,}/)
  const out: CaptionSegment[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    const idx = lines.findIndex((l) => ARROW.test(l))
    if (idx < 0) continue
    const m = ARROW.exec(lines[idx]!)!
    const start = parseSubtitleTime(m[1]!)
    const end = parseSubtitleTime(m[2]!)
    if (end <= start) continue
    let speaker: string | undefined
    let content = lines.slice(idx + 1).join('\n')
    const voice = /^<v\s+([^>]+)>/.exec(content)
    if (voice) {
      speaker = voice[1]!.trim()
      content = content.slice(voice[0].length)
    }
    content = content.replace(/<[^>]+>/g, '').trim()
    if (!content) continue
    out.push({ id: newId(), start, end, text: content, ...(speaker ? { speaker } : {}) })
  }
  return out.sort((a, b) => a.start - b.start)
}
