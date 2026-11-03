import { TimelineDoc } from '@orion/shared'
import { clipEnd, docDuration, isMediaClip } from './evaluate.ts'
import { TRACK_ACCEPTS } from './ops.ts'
import { FLICKS_PER_SECOND, isFrameAligned, isSupportedFps } from './time.ts'

export interface AssetInfo {
  id: string
  kind: 'VIDEO' | 'AUDIO' | 'IMAGE' | 'SUBTITLE'
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED'
  durationFlicks: number | null
  hasAudio: boolean
  hasVideo: boolean
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  clipId?: string
  trackId?: string
}

export interface ValidateOptions {
  maxDurationSeconds?: number
  assets?: Map<string, AssetInfo>
  /** exige ativos prontos (usado antes de renderizar) */
  requireReadyAssets?: boolean
}

/** Valida estrutura (schema) e regras de domínio da timeline. */
export function validateDoc(input: unknown, opts: ValidateOptions = {}): {
  doc: TimelineDoc | null
  issues: ValidationIssue[]
} {
  const parsed = TimelineDoc.safeParse(input)
  if (!parsed.success) {
    return {
      doc: null,
      issues: parsed.error.issues.slice(0, 20).map((i) => ({
        severity: 'error',
        code: 'schema',
        message: `${i.path.join('.')}: ${i.message}`,
      })),
    }
  }
  const doc = parsed.data
  const issues: ValidationIssue[] = []
  const fps = doc.settings.fps
  if (!isSupportedFps(fps)) {
    issues.push({ severity: 'error', code: 'fps', message: `Frame rate ${fps.num}/${fps.den} não suportado.` })
  }
  if (doc.settings.width % 2 || doc.settings.height % 2) {
    issues.push({ severity: 'error', code: 'dimensions', message: 'Largura e altura devem ser pares (H.264 4:2:0).' })
  }
  if (doc.settings.width * doc.settings.height > 3840 * 2160) {
    issues.push({ severity: 'error', code: 'dimensions', message: 'Dimensões acima do limite operacional (4K).' })
  }
  const ids = new Set<string>()
  for (const track of doc.tracks) {
    const sorted = [...track.clips].sort((a, b) => a.start - b.start)
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!
      if (ids.has(c.id)) issues.push({ severity: 'error', code: 'duplicate_id', message: `ID duplicado ${c.id}`, clipId: c.id })
      ids.add(c.id)
      if (!TRACK_ACCEPTS[track.kind].includes(c.type)) {
        issues.push({ severity: 'error', code: 'track_kind', message: `"${c.name}" incompatível com a trilha ${track.name}.`, clipId: c.id, trackId: track.id })
      }
      if (!isFrameAligned(c.start, fps) || !isFrameAligned(c.duration, fps)) {
        issues.push({ severity: 'error', code: 'frame_alignment', message: `"${c.name}" não está alinhado aos frames do projeto.`, clipId: c.id })
      }
      const next = sorted[i + 1]
      if (next && next.start < clipEnd(c)) {
        issues.push({ severity: 'error', code: 'overlap', message: `"${c.name}" e "${next.name}" se sobrepõem na trilha ${track.name}.`, clipId: next.id, trackId: track.id })
      }
      if (c.transitionIn && c.transitionIn.duration > c.duration) {
        issues.push({ severity: 'error', code: 'transition', message: `Transição maior que o clipe "${c.name}".`, clipId: c.id })
      }
      if (isMediaClip(c) && opts.assets) {
        const a = opts.assets.get(c.assetId)
        if (!a) {
          issues.push({ severity: 'error', code: 'asset_missing', message: `Mídia de "${c.name}" não encontrada.`, clipId: c.id })
          continue
        }
        if (opts.requireReadyAssets && a.status !== 'READY') {
          issues.push({ severity: 'error', code: 'asset_not_ready', message: `Mídia de "${c.name}" ainda está em processamento (${a.status}).`, clipId: c.id })
        }
        const expected = c.type === 'image' ? 'IMAGE' : c.type === 'audio' ? null : 'VIDEO'
        if (expected && a.kind !== expected) {
          issues.push({ severity: 'error', code: 'asset_kind', message: `Tipo de mídia incorreto em "${c.name}".`, clipId: c.id })
        }
        if (c.type === 'audio' && !a.hasAudio) {
          issues.push({ severity: 'error', code: 'asset_no_audio', message: `"${c.name}" não possui áudio.`, clipId: c.id })
        }
        if (c.type !== 'image' && a.durationFlicks !== null) {
          const needed = c.sourceIn + Math.round(c.duration * c.speed)
          // tolerância de 1 frame para durações de contêiner arredondadas
          const tol = Math.round((FLICKS_PER_SECOND * fps.den) / fps.num)
          if (needed > a.durationFlicks + tol) {
            issues.push({ severity: 'warning', code: 'beyond_source', message: `"${c.name}" ultrapassa o fim da mídia; o último frame será mantido.`, clipId: c.id })
          }
        }
      }
    }
  }
  for (const s of doc.captions.segments) {
    if (s.end <= s.start) issues.push({ severity: 'error', code: 'caption_range', message: `Legenda "${s.text.slice(0, 30)}" com fim antes do início.` })
  }
  if (!doc.captionStyles.some((s) => s.id === doc.captions.styleId)) {
    issues.push({ severity: 'error', code: 'caption_style', message: 'Estilo de legenda selecionado não existe.' })
  }
  const dur = docDuration(doc)
  if (opts.maxDurationSeconds && dur > opts.maxDurationSeconds * FLICKS_PER_SECOND) {
    issues.push({ severity: 'error', code: 'too_long', message: `Projeto excede o limite de ${Math.round(opts.maxDurationSeconds / 60)} minutos do plano.` })
  }
  return { doc, issues }
}

export const hasErrors = (issues: ValidationIssue[]) => issues.some((i) => i.severity === 'error')
