'use client'
import type { GenerationRequest, Scene } from '@orion/shared'
import { FLICKS_PER_SECOND, assembleScenes, clipEnd, formatClock, planShots, replaceClipAsset, updateClip } from '@orion/timeline'
import { Badge, Button, Field, Select, TextArea, useToast } from '@orion/ui'
import { produce } from 'immer'
import { Check, Clapperboard, Image as ImageIcon, LayoutList, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { AssetDto, GenerationDto, ProvidersDto } from '@/lib/types'
import { useDoc, useEditor } from '../store'
import { useGeneration } from '../useGeneration'

interface CharacterLite {
  id: string
  name: string
  references: Array<{ asset: AssetDto }>
}

/**
 * Cenas por IA: cada cena do storyboard é gerada como trabalho independente,
 * respeitando as durações suportadas pelo provedor (cenas longas viram várias
 * tomadas). Resultados ficam no histórico; o usuário aprova, compara com as
 * referências dos personagens e substitui/regenera só aquela cena.
 * Continuidade entre cenas NÃO é garantida pelo modelo — revise transições.
 */
export function ScenesPanel() {
  const doc = useDoc()
  const { workspaceId, projectId, apply, upsertAsset, setPlayhead, assets } = useEditor()
  const toast = useToast()
  const { run, dialog, busy } = useGeneration(workspaceId, projectId)
  const [providers, setProviders] = useState<ProvidersDto | null>(null)
  const [mode, setMode] = useState<'image' | 'video'>('image')
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [history, setHistory] = useState<GenerationDto[]>([])
  const [characters, setCharacters] = useState<CharacterLite[]>([])
  useEffect(() => {
    api<ProvidersDto>('/providers').then(setProviders).catch(() => undefined)
    api<CharacterLite[]>(`/workspaces/${workspaceId}/characters`).then(setCharacters).catch(() => undefined)
    api<GenerationDto[]>(`/workspaces/${workspaceId}/generations?projectId=${projectId}`)
      .then((g) => setHistory(g.filter((x) => x.kind === 'IMAGE' || x.kind === 'VIDEO')))
      .catch(() => undefined)
  }, [workspaceId, projectId])
  const list = mode === 'image' ? (providers?.image ?? []) : (providers?.video ?? [])
  const configured = list.filter((p) => p.configured)
  const provider = configured.find((p) => p.id === providerId) ?? configured[0]
  const models = (provider?.models ?? []) as Array<{ id: string; label: string; durations?: number[]; resolutions?: string[]; aspects?: string[]; notes?: string }>
  const model = models.find((m) => m.id === modelId) ?? models[0]
  const aspect = doc.settings.aspect === '16:9' ? '16:9' : '9:16'

  function updateScene(key: string, patch: Partial<Scene>) {
    apply((d) => produce(d, (x) => void Object.assign(x.scenes.find((s) => s.key === key)!, patch)), { coalesce: `scene:${key}:${Object.keys(patch).join()}` })
  }

  async function generate(scene: Scene) {
    if (!provider || !model) return
    let reqs: GenerationRequest[]
    if (mode === 'image') {
      reqs = [{ kind: 'IMAGE', provider: provider.id, model: model.id, prompt: scene.visualPrompt, aspect: doc.settings.aspect === 'custom' ? '16:9' : doc.settings.aspect, characterIds: scene.characterIds, sceneKey: scene.key }]
    } else {
      const shots = planShots(scene.estimatedDuration / FLICKS_PER_SECOND, model.durations ?? [8])
      reqs = shots.map((dur, i) => ({ kind: 'VIDEO', provider: provider.id, model: model.id, mode: 'text-to-video', prompt: shots.length > 1 ? `${scene.visualPrompt} (tomada ${i + 1} de ${shots.length}, continuação)` : scene.visualPrompt, durationSeconds: dur, aspect, resolution: (model.resolutions?.[0] ?? '720p') as '720p' | '1080p', characterIds: scene.characterIds, sceneKey: scene.key }))
    }
    const results = await run(reqs, `Gerar ${reqs.length > 1 ? `${reqs.length} tomadas` : '1 resultado'} para “${scene.title}” com ${provider.label}${provider.mode === 'mock' ? ' (MODO DE TESTE)' : ''}. A continuidade entre tomadas não é garantida.`)
    const ok = results.filter((g): g is GenerationDto => !!g && g.status === 'succeeded')
    for (const g of results) if (g && g.status !== 'succeeded') toast(g.error ?? 'Falha na geração', 'danger')
    if (!ok.length) return
    setHistory((h) => [...ok, ...h])
    const assetsNew = await api<AssetDto[]>('/assets/batch', { body: { ids: ok.map((g) => g.resultAssetId!) } })
    assetsNew.forEach(upsertAsset)
    placeResults(scene, ok)
  }

  /** Substitui (ou cria) os clipes da cena na trilha principal com os resultados. */
  function placeResults(scene: Scene, gens: GenerationDto[]) {
    apply((d) => {
      const main = d.tracks.find((t) => t.kind === 'video')!
      const existing = main.clips.filter((c) => c.sceneKey === scene.key).sort((a, b) => a.start - b.start)
      if (!existing.length) {
        const first = gens[0]!
        const a = useEditor.getState().assets[first.resultAssetId!]
        return assembleScenes(d, [scene], [{ sceneKey: scene.key, visual: { assetId: first.resultAssetId!, type: first.kind === 'VIDEO' ? 'video' : 'image', durationFlicks: a?.durationFlicks ?? null } }])
      }
      let out = d
      // distribui as tomadas pelos clipes existentes da cena (mantém duração e posição)
      existing.forEach((c, i) => {
        const g = gens[Math.min(i, gens.length - 1)]!
        const a = useEditor.getState().assets[g.resultAssetId!]
        const type = g.kind === 'VIDEO' ? 'video' : 'image'
        out = produce(out, (x) => {
          const cc = x.tracks.flatMap((t) => t.clips).find((y) => y.id === c.id)
          if (cc && cc.type !== 'text' && cc.type !== 'audio') {
            if (cc.type === 'color') {
              const replacement = { ...cc, type, assetId: g.resultAssetId!, sourceIn: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, name: scene.title } as unknown as typeof cc
              Object.assign(cc, replacement)
            }
          }
        })
        if (c.type !== 'color') out = replaceClipAsset(out, c.id, g.resultAssetId!, a?.durationFlicks ?? null)
        out = updateClip(out, c.id, (cc) => void (cc.name = scene.title))
      })
      return out
    })
  }

  async function approve(g: GenerationDto, approved: boolean) {
    try {
      const upd = await api<GenerationDto>(`/generations/${g.id}/approve`, { body: { approved } })
      setHistory((h) => h.map((x) => (x.id === g.id ? upd : x)))
      if (approved) apply((d) => produce(d, (x) => void x.scenes.forEach((s) => s.key === g.sceneKey && (s.status = 'approved'))))
    } catch (err) {
      toast(errorMessage(err), 'danger')
    }
  }

  return (
    <div className="p-3 flex flex-col gap-3 text-sm">
      {dialog}
      <div className="flex gap-2 items-center">
        <Select aria-label="Tipo de geração" value={mode} onChange={(e) => setMode(e.target.value as 'image' | 'video')}>
          <option value="image">Imagem (storyboard)</option>
          <option value="video">Vídeo (cena animada)</option>
        </Select>
      </div>
      {!configured.length ? (
        <p className="text-[12px] text-[var(--color-muted)]">
          <Badge tone="warn">Configuração pendente</Badge> {mode === 'video' ? 'Defina GEMINI_API_KEY (Google Veo)' : 'Defina OPENAI_API_KEY (imagens)'} no servidor. As cenas ainda podem ser montadas com mídia própria.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Provedor" htmlFor="gp">
            <Select id="gp" value={provider?.id} onChange={(e) => setProviderId(e.target.value)}>
              {configured.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} {p.mode === 'mock' ? '(teste)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Modelo" htmlFor="gm" hint={model?.durations ? `Durações por geração: ${model.durations.join(', ')} s` : undefined}>
            <Select id="gm" value={model?.id} onChange={(e) => setModelId(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {doc.scenes.length === 0 ? (
        <p className="text-[12px] text-[var(--color-muted)]">Este projeto não tem storyboard. Use o Assistente para transformar um roteiro em cenas ou aplique um template.</p>
      ) : (
        <>
          <Button
            size="sm"
            icon={<LayoutList size={14} />}
            onClick={() => {
              const main = doc.tracks.find((t) => t.kind === 'video')!
              const missing = doc.scenes.filter((s) => !main.clips.some((c) => c.sceneKey === s.key))
              if (!missing.length) return toast('Todas as cenas já estão na timeline.', 'info')
              apply((d) => assembleScenes(d, missing, []))
            }}
          >
            Montar cenas pendentes na timeline
          </Button>
          <ol className="flex flex-col gap-2">
            {doc.scenes.map((s, i) => {
              const clips = doc.tracks.flatMap((t) => t.clips).filter((c) => c.sceneKey === s.key && c.type !== 'audio')
              const results = history.filter((g) => g.sceneKey === s.key && g.status === 'succeeded')
              const chars = characters.filter((c) => s.characterIds.includes(c.id))
              return (
                <li key={s.key} className="rounded-lg border border-[var(--color-border)] p-2.5 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--color-muted)] tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                    <span className="font-medium flex-1 truncate">{s.title}</span>
                    <Badge tone={s.status === 'approved' ? 'ok' : 'neutral'}>{s.status === 'approved' ? 'Aprovada' : 'Rascunho'}</Badge>
                    <span className="text-[11px] tabular-nums text-[var(--color-muted)]">~{(s.estimatedDuration / FLICKS_PER_SECOND).toFixed(1).replace('.', ',')} s</span>
                  </div>
                  <TextArea aria-label={`Prompt visual da cena ${i + 1}`} className="min-h-[60px] text-[12px]" value={s.visualPrompt} onChange={(e) => updateScene(s.key, { visualPrompt: e.target.value })} />
                  {characters.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {characters.map((c) => (
                        <button key={c.id} className={`text-[11px] rounded-full px-2 py-0.5 border ${s.characterIds.includes(c.id) ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`} aria-pressed={s.characterIds.includes(c.id)} onClick={() => updateScene(s.key, { characterIds: s.characterIds.includes(c.id) ? s.characterIds.filter((x) => x !== c.id) : [...s.characterIds, c.id].slice(0, 4) })}>
                          {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {clips[0] && (
                      <Button size="sm" variant="ghost" onClick={() => setPlayhead(clips[0]!.start)}>
                        Ir para {formatClock(clips[0].start)}
                      </Button>
                    )}
                    <Button size="sm" variant="primary" icon={mode === 'image' ? <ImageIcon size={12} /> : <Clapperboard size={12} />} disabled={!provider} loading={busy} onClick={() => generate(s)}>
                      {results.length ? 'Regenerar esta cena' : 'Gerar cena'}
                    </Button>
                  </div>
                  {results.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <div className="text-[11px] text-[var(--color-muted)]">Resultados (compare com as referências):</div>
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {chars.flatMap((c) => c.references.slice(0, 1).map((r) => (
                          <figure key={`ref-${c.id}`} className="shrink-0 w-20">
                            <img src={r.asset.thumbnailUrl ?? r.asset.originalUrl ?? ''} alt={`Referência de ${c.name}`} className="w-20 h-20 object-cover rounded border border-[var(--color-blue)]" />
                            <figcaption className="text-[10px] truncate text-[var(--color-blue)]">Ref.: {c.name}</figcaption>
                          </figure>
                        )))}
                        {results.map((g) => {
                          const a = assets[g.resultAssetId ?? '']
                          const inUse = clips.some((c) => 'assetId' in c && c.assetId === g.resultAssetId)
                          return (
                            <figure key={g.id} className="shrink-0 w-24 flex flex-col gap-1">
                              <img src={a?.thumbnailUrl ?? a?.originalUrl ?? ''} alt={`Resultado de ${s.title}`} className={`w-24 h-20 object-cover rounded border ${inUse ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`} />
                              <div className="flex gap-0.5">
                                <button className="text-[10px] underline" onClick={() => placeResults(s, [g])} disabled={inUse}>
                                  {inUse ? 'Em uso' : 'Usar'}
                                </button>
                                <button className="text-[10px] ml-auto" aria-label={g.approved ? 'Desaprovar' : 'Aprovar'} title={g.approved ? 'Aprovado (será reutilizado)' : 'Aprovar'} onClick={() => approve(g, !g.approved)}>
                                  {g.approved ? <Check size={12} className="text-[var(--color-ok)]" /> : <RotateCcw size={12} />}
                                </button>
                              </div>
                            </figure>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {clips.length > 1 && <p className="text-[11px] text-[var(--color-muted)]">{clips.length} tomadas na timeline · revise as transições ({clips.map((c) => formatClock(clipEnd(c))).join(', ')})</p>}
                </li>
              )
            })}
          </ol>
        </>
      )}
    </div>
  )
}
