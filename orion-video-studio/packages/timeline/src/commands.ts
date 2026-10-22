import type { TimelineDoc } from '@orion/shared'
import { z } from 'zod'
import { clipEnd, docDuration } from './evaluate.ts'
import {
  EditError,
  deleteClips,
  duplicateClip,
  makeMediaClip,
  setClipSpeed,
  setTrackFlags,
  splitClip,
  trimClip,
} from './ops.ts'
import { FLICKS_PER_SECOND, quantize, secondsToFlicks } from './time.ts'
import { produce } from 'immer'

/**
 * Comandos estruturados do assistente. Toda instrução em linguagem natural
 * (parser local ou LLM) precisa virar um destes objetos validados antes de
 * tocar no projeto. O cliente aplica numa cópia, mostra a prévia e só então
 * confirma (com undo disponível).
 */
export const StructuredCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('split'), clipId: z.string(), at: z.number().int().nonnegative() }),
  z.object({ type: z.literal('trim'), clipId: z.string(), edge: z.enum(['start', 'end']), time: z.number().int().nonnegative() }),
  z.object({ type: z.literal('delete'), clipIds: z.array(z.string()).min(1), ripple: z.boolean() }),
  z.object({ type: z.literal('duplicate'), clipId: z.string() }),
  z.object({ type: z.literal('speed'), clipId: z.string(), speed: z.number().min(0.25).max(4) }),
  z.object({ type: z.literal('trackVolume'), trackKind: z.enum(['music', 'voice', 'audio', 'video']), factor: z.number().min(0).max(4) }),
  z.object({ type: z.literal('replaceMusic'), musicTrackId: z.string(), assetId: z.string(), durationFlicks: z.number().int().positive(), title: z.string() }),
  z.object({ type: z.literal('shortenIntro'), seconds: z.number().positive().max(600) }),
  z.object({ type: z.literal('applyBrandKit'), brandKitId: z.string() }),
  z.object({ type: z.literal('changeVoice'), voiceId: z.string() }),
])
export type StructuredCommand = z.infer<typeof StructuredCommand>

export interface MusicOption {
  id: string
  assetId: string
  durationFlicks: number
  title: string
}

export interface ParseContext {
  selectedClipId?: string
  playhead: number
  music?: MusicOption[]
  brandKitIds?: string[]
  voices?: Array<{ id: string; name: string }>
}

export interface ParseResult {
  commands: StructuredCommand[]
  summary: string
  /** exige geração paga (estimativa antes) */
  requiresPaidGeneration: boolean
  understood: boolean
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

function parseNumber(text: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)/.exec(text)
  return m ? Number(m[1]!.replace(',', '.')) : null
}

/** Parser local determinístico (sem IA) para os comandos suportados. */
export function parseCommand(doc: TimelineDoc, input: string, ctx: ParseContext): ParseResult {
  const text = norm(input)
  const sel = ctx.selectedClipId
  const fail = (summary: string): ParseResult => ({ commands: [], summary, requiresPaidGeneration: false, understood: false })

  if (/\b(troqu|troca|mud|substitu)\w*\b.*\bmusica\b/.test(text)) {
    const music = doc.tracks.find((t) => t.kind === 'music')
    const currentAsset = music?.clips[0]?.type === 'audio' ? music.clips[0].assetId : null
    const options = (ctx.music ?? []).filter((m) => m.assetId !== currentAsset)
    const named = options.find((m) => text.includes(norm(m.title)))
    const pick = named ?? options[0]
    if (!pick) return fail('Nenhuma outra música disponível na biblioteca para trocar.')
    return {
      commands: [{ type: 'replaceMusic', musicTrackId: pick.id, assetId: pick.assetId, durationFlicks: pick.durationFlicks, title: pick.title }],
      summary: `Trocar a música por "${pick.title}" (com loop até o fim do vídeo).`,
      requiresPaidGeneration: false,
      understood: true,
    }
  }
  if (/\b(encurt|reduz|diminu)\w*\b.*\b(introducao|abertura|inicio)\b/.test(text)) {
    const n = parseNumber(text)
    const main = doc.tracks.find((t) => t.kind === 'video')
    const first = main?.clips[0]
    if (!first) return fail('Não há abertura na trilha principal.')
    const secs = n ?? Math.max(0.5, Math.round((first.duration / FLICKS_PER_SECOND) * 0.3 * 10) / 10)
    return {
      commands: [{ type: 'shortenIntro', seconds: secs }],
      summary: `Encurtar a abertura ("${first.name}") em ${secs.toString().replace('.', ',')} s e recuar o restante.`,
      requiresPaidGeneration: false,
      understood: true,
    }
  }
  if (/\b(divid|cort|separ|quebr)\w*\b/.test(text) && !/\bsilencio/.test(text)) {
    if (!sel) return fail('Selecione um clipe e posicione o cursor onde deseja dividir.')
    return { commands: [{ type: 'split', clipId: sel, at: ctx.playhead }], summary: 'Dividir o clipe selecionado na posição do cursor.', requiresPaidGeneration: false, understood: true }
  }
  if (/\b(mud|troc|alter)\w*\b.*\bvoz\b/.test(text)) {
    const voice = (ctx.voices ?? []).find((v) => text.includes(norm(v.name))) ?? ctx.voices?.[0]
    if (!voice) return fail('Nenhuma voz configurada. Cadastre uma voz no Estúdio de Voz.')
    return {
      commands: [{ type: 'changeVoice', voiceId: voice.id }],
      summary: `Regenerar a narração com a voz "${voice.name}". Isso usa o provedor de voz (custo estimado antes).`,
      requiresPaidGeneration: true,
      understood: true,
    }
  }
  if (/\b(apliqu|aplica|usar|use)\w*\b.*\b(identidade|marca|kit)\b/.test(text)) {
    const id = ctx.brandKitIds?.[0]
    if (!id) return fail('Nenhum kit de marca cadastrado. Crie um em Identidade Visual.')
    return { commands: [{ type: 'applyBrandKit', brandKitId: id }], summary: 'Aplicar sua identidade visual (cores, legendas, marca-d’água, assinatura).', requiresPaidGeneration: false, understood: true }
  }
  if (/\b(apag|exclu|remov|delet)\w*\b/.test(text)) {
    if (!sel) return fail('Selecione o clipe que deseja excluir.')
    return { commands: [{ type: 'delete', clipIds: [sel], ripple: /\b(feche|fechar|ripple|sem buraco|junt)\w*/.test(text) }], summary: 'Excluir o clipe selecionado.', requiresPaidGeneration: false, understood: true }
  }
  if (/\bduplic\w*\b/.test(text)) {
    if (!sel) return fail('Selecione o clipe que deseja duplicar.')
    return { commands: [{ type: 'duplicate', clipId: sel }], summary: 'Duplicar o clipe selecionado.', requiresPaidGeneration: false, understood: true }
  }
  if (/\b(aceler|velocidade|mais rapido|camera lenta|desaceler)\w*/.test(text)) {
    if (!sel) return fail('Selecione um clipe de vídeo ou áudio.')
    const n = parseNumber(text)
    const speed = n ?? (/lent|desaceler/.test(text) ? 0.5 : 1.5)
    return { commands: [{ type: 'speed', clipId: sel, speed }], summary: `Ajustar velocidade para ${String(speed).replace('.', ',')}×.`, requiresPaidGeneration: false, understood: true }
  }
  if (/\b(aument|diminu|abaix|baix|sob)\w*\b.*\b(volume|som)\b.*\bmusica\b|\bmusica\b.*\b(mais alta|mais baixa)/.test(text)) {
    const up = /\b(aument|sob|mais alta)/.test(text)
    return { commands: [{ type: 'trackVolume', trackKind: 'music', factor: up ? 1.4 : 0.6 }], summary: `${up ? 'Aumentar' : 'Diminuir'} o volume da música.`, requiresPaidGeneration: false, understood: true }
  }
  return fail('Não entendi o comando. Exemplos: "troque a música", "encurte a introdução", "divida esta cena", "mude a voz", "aplique minha identidade visual".')
}

/** Executa comandos puros sobre o documento (brand kit e voz são resolvidos pelo cliente). */
export function executeCommand(doc: TimelineDoc, cmd: StructuredCommand): TimelineDoc {
  switch (cmd.type) {
    case 'split':
      return splitClip(doc, cmd.clipId, cmd.at)
    case 'trim':
      return trimClip(doc, cmd.clipId, cmd.edge, cmd.time)
    case 'delete':
      return deleteClips(doc, cmd.clipIds, cmd.ripple)
    case 'duplicate':
      return duplicateClip(doc, cmd.clipId).doc
    case 'speed':
      return setClipSpeed(doc, cmd.clipId, cmd.speed)
    case 'trackVolume': {
      let out = doc
      for (const t of doc.tracks.filter((x) => x.kind === cmd.trackKind)) {
        out = setTrackFlags(out, t.id, { volume: Math.min(2, Math.max(0, t.volume * cmd.factor)) })
      }
      return out
    }
    case 'replaceMusic': {
      const total = docDuration(doc)
      return produce(doc, (d) => {
        let music = d.tracks.find((t) => t.kind === 'music')
        if (!music) throw new EditError('Projeto sem trilha de música.', 'no_music_track')
        music.clips = []
        // loop: repete a faixa até cobrir o vídeo
        let t = 0
        let i = 0
        const step = quantize(cmd.durationFlicks, doc.settings.fps, 'floor')
        while (t < total && i < 500) {
          const dur = Math.min(step, total - t)
          const c = makeMediaClip('audio', cmd.assetId, t, dur, cmd.title)
          if (c.type === 'audio') {
            c.fadeIn = i === 0 ? quantize(secondsToFlicks(0.5), doc.settings.fps) : 0
            c.fadeOut = t + dur >= total ? Math.min(dur, quantize(secondsToFlicks(1.5), doc.settings.fps)) : 0
          }
          music.clips.push(c)
          t += dur
          i++
        }
      })
    }
    case 'shortenIntro': {
      const main = doc.tracks.find((t) => t.kind === 'video')
      const first = main?.clips[0]
      if (!first) throw new EditError('Não há abertura.', 'no_intro')
      const cut = Math.min(quantize(secondsToFlicks(cmd.seconds), doc.settings.fps), first.duration - quantize(secondsToFlicks(0.5), doc.settings.fps))
      if (cut <= 0) throw new EditError('A abertura já está no mínimo.', 'intro_min')
      const end = clipEnd(first)
      return produce(doc, (d) => {
        const f = d.tracks.find((t) => t.id === main!.id)!.clips.find((c) => c.id === first.id)!
        f.duration -= cut
        f.keyframes = f.keyframes.filter((k) => k.time <= f.duration)
        for (const t of d.tracks) {
          for (const c of t.clips) {
            if (c.id === first.id) continue
            if (c.start >= end) c.start -= cut
            else if (c.start < end && clipEnd(c) > end - cut && c.start >= first.start) {
              // elementos que cruzam a região cortada são encurtados
              const newEnd = Math.max(c.start + 1, clipEnd(c) - cut)
              c.duration = quantize(newEnd - c.start, doc.settings.fps, 'floor') || c.duration
            }
          }
        }
        for (const s of d.captions.segments) {
          if (s.start >= end) {
            s.start -= cut
            s.end -= cut
            if (s.words) for (const w of s.words) {
              w.start -= cut
              w.end -= cut
            }
          }
        }
        d.captions.segments = d.captions.segments.filter((s) => s.end > s.start)
        for (const m of d.markers) if (m.time >= end) m.time -= cut
      })
    }
    case 'applyBrandKit':
    case 'changeVoice':
      throw new EditError('Este comando é resolvido pelo editor (requer dados do servidor).', 'client_resolved')
  }
}

/** Resumo legível do efeito de uma lista de comandos (prévia de alterações). */
export function diffSummary(before: TimelineDoc, after: TimelineDoc): string[] {
  const lines: string[] = []
  const map = (doc: TimelineDoc) => new Map(doc.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)))
  const a = map(before)
  const b = map(after)
  let changed = 0
  for (const [id] of a) if (!b.has(id)) lines.push(`Removido: ${a.get(id)!.name}`)
  for (const [id, c] of b) {
    if (!a.has(id)) lines.push(`Adicionado: ${c.name}`)
    else if (JSON.stringify(a.get(id)) !== JSON.stringify(c)) changed++
  }
  if (changed) lines.push(`${changed} clipe(s) alterado(s)`)
  const da = docDuration(before)
  const db = docDuration(after)
  if (da !== db) lines.push(`Duração: ${(da / FLICKS_PER_SECOND).toFixed(1)} s → ${(db / FLICKS_PER_SECOND).toFixed(1)} s`)
  return lines
}
