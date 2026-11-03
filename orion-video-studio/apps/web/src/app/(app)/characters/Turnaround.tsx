'use client'
import { CHARACTER_ANGLE_LABELS, CHARACTER_ANGLES, type CharacterViewAngle } from '@orion/shared'
import { Badge, Button, Select, useToast } from '@orion/ui'
import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useGeneration } from '@/components/editor/useGeneration'
import { api, errorMessage } from '@/lib/api'
import type { AssetDto, GenerationDto, ProvidersDto } from '@/lib/types'

const DEFAULT_STYLE = 'desenho 2D infantil, formas arredondadas e simpáticas, olhos grandes e expressivos, contornos limpos, cores chapadas e vibrantes'

type Views = Record<'SHEET' | CharacterViewAngle, string> & { characterId: string }

/**
 * Folha de personagem em 3 ângulos: gera uma única imagem com frente, 3/4 e
 * perfil (mesmo personagem nas três vistas), mostra os recortes e só vira
 * referência depois da aprovação. Sem a folha aprovada, cenas com o
 * personagem são bloqueadas pelo servidor.
 */
export function TurnaroundSection({
  workspaceId,
  character,
  onApproved,
}: {
  workspaceId: string
  character: { id: string; name: string; references: Array<{ assetId: string; angle?: string | null; asset: AssetDto }>; turnaroundComplete?: boolean }
  onApproved: () => void
}) {
  const toast = useToast()
  const { run, dialog, busy } = useGeneration(workspaceId)
  const [providers, setProviders] = useState<ProvidersDto | null>(null)
  const [provider, setProvider] = useState('')
  const [style, setStyle] = useState(DEFAULT_STYLE)
  const [draft, setDraft] = useState<{ gen: GenerationDto; views: Views; assets: Record<string, AssetDto> } | null>(null)
  useEffect(() => {
    api<ProvidersDto>('/providers')
      .then((p) => {
        setProviders(p)
        setProvider(p.image.find((x) => x.configured)?.id ?? '')
      })
      .catch(() => undefined)
  }, [])
  const approvedViews = Object.fromEntries(character.references.filter((r) => r.angle).map((r) => [r.angle!, r.asset]))
  const image = providers?.image.find((p) => p.id === provider)

  async function generate() {
    if (!image) return
    const [g] = await run(
      [{ kind: 'IMAGE', provider: image.id, model: image.models[0]!.id, prompt: style.trim() || DEFAULT_STYLE, aspect: '16:9', turnaroundFor: character.id, characterIds: [] }],
      `Folha de “${character.name}” em 3 ângulos (frente, 3/4 e perfil) com ${image.label}${image.mode === 'mock' ? ' (MODO DE TESTE)' : ''}.`,
    )
    if (!g) return
    if (g.status !== 'succeeded') return toast(g.error ?? 'A geração da folha falhou.', 'danger')
    const views = (g.result as { turnaround?: Views } | null)?.turnaround
    if (!views) return toast('A geração não devolveu as três vistas.', 'danger')
    const list = await api<AssetDto[]>('/assets/batch', { body: { ids: ['SHEET', ...CHARACTER_ANGLES].map((k) => views[k as keyof Views]) } })
    setDraft({ gen: g, views, assets: Object.fromEntries(list.map((a) => [a.id, a])) })
  }

  async function approve() {
    if (!draft) return
    try {
      await api(`/characters/${character.id}/turnaround`, { body: { generationJobId: draft.gen.id } })
      setDraft(null)
      toast('Folha aprovada: as três vistas agora são as referências do personagem.', 'ok')
      onApproved()
    } catch (err) {
      toast(errorMessage(err), 'danger')
    }
  }

  const thumb = (a?: AssetDto) => a?.thumbnailUrl ?? a?.originalUrl ?? ''
  return (
    <section className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2" aria-label={`Folha de ${character.name} em 3 ângulos`}>
      {dialog}
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="font-medium text-[14px]">Folha em 3 ângulos</h3>
        {character.turnaroundComplete ? <Badge tone="ok">aprovada</Badge> : <Badge tone="warn">pendente: obrigatória para gerar cenas</Badge>}
      </div>
      {character.turnaroundComplete && !draft && (
        <div className="flex gap-2">
          {CHARACTER_ANGLES.map((a) => (
            <figure key={a} className="w-28">
              <img src={thumb(approvedViews[a])} alt={`${character.name} — ${CHARACTER_ANGLE_LABELS[a]}`} className="w-28 h-36 object-contain rounded bg-white" />
              <figcaption className="text-[11px] text-[var(--color-muted)]">{CHARACTER_ANGLE_LABELS[a]}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {draft && (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-[var(--color-muted)]">Confira se as três vistas mostram o mesmo personagem, na mesma escala. Se algo destoar, gere de novo antes de aprovar.</p>
          <div className="flex gap-2 flex-wrap">
            {CHARACTER_ANGLES.map((a) => (
              <figure key={a} className="w-28">
                <img src={thumb(draft.assets[draft.views[a]])} alt={`Prévia — ${CHARACTER_ANGLE_LABELS[a]}`} className="w-28 h-36 object-contain rounded bg-white border-2 border-[var(--color-accent)]" />
                <figcaption className="text-[11px]">{CHARACTER_ANGLE_LABELS[a]}</figcaption>
              </figure>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={approve}>
              Aprovar folha
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Descartar
            </Button>
          </div>
        </div>
      )}
      {!providers ? null : !image ? (
        <p className="text-[12px] text-[var(--color-muted)]">
          <Badge tone="warn">Configuração pendente</Badge> Configure um provedor de imagens (ex.: OPENAI_API_KEY) no servidor para gerar a folha.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="text-[12px] text-[var(--color-muted)]" htmlFor={`st-${character.id}`}>
            Estilo visual (o mesmo em todos os episódios)
          </label>
          <input id={`st-${character.id}`} className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[13px]" value={style} onChange={(e) => setStyle(e.target.value)} />
          <div className="flex gap-2 items-center">
            <Select aria-label="Provedor de imagem" value={provider} onChange={(e) => setProvider(e.target.value)} className="w-56">
              {providers.image
                .filter((p) => p.configured)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.mode === 'mock' ? ' (MODO DE TESTE)' : ''}
                  </option>
                ))}
            </Select>
            <Button size="sm" icon={<RotateCw size={14} />} loading={busy} onClick={generate}>
              {character.turnaroundComplete ? 'Gerar nova folha' : 'Gerar folha em 3 ângulos'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
