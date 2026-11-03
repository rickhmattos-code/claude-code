'use client'
import type { Clip, Effect, EffectType, KeyframeProperty, TextStyle, TimelineDoc } from '@orion/shared'
import { EFFECT_SUPPORT } from '@orion/shared'
import {
  ASPECT_DIMENSIONS,
  FLICKS_PER_SECOND,
  addClip,
  applyZoom,
  clipEnd,
  findClip,
  formatTimecode,
  keyframePiecewise,
  evalPiecewise,
  makeMediaClip,
  newId,
  quantize,
  removeKeyframe,
  replaceClipAsset,
  secondsToFlicks,
  setClipSpeed,
  setKeyframe,
  setTrackFlags,
  splitClip,
  updateClip,
} from '@orion/timeline'
import { Badge, Button, Field, Input, Select, Slider, TextArea, useToast } from '@orion/ui'
import { Diamond, Snowflake, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { waitForAsset } from '@/lib/upload'
import { useDoc, useEditor } from './store'

const PROPS: Array<{ key: KeyframeProperty; label: string; min: number; max: number; step: number; fmt: (v: number) => string }> = [
  { key: 'x', label: 'Posição X', min: -0.5, max: 1.5, step: 0.005, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'y', label: 'Posição Y', min: -0.5, max: 1.5, step: 0.005, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'scale', label: 'Escala', min: 0.05, max: 4, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'rotation', label: 'Rotação', min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` },
  { key: 'opacity', label: 'Opacidade', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
]

const EFFECT_DEFAULTS: Record<EffectType, () => Effect> = {
  color: () => ({ id: newId(), type: 'color', brightness: 0, contrast: 1, saturation: 1 }),
  temperature: () => ({ id: newId(), type: 'temperature', kelvin: 5200 }),
  blur: () => ({ id: newId(), type: 'blur', radius: 6 }),
  vignette: () => ({ id: newId(), type: 'vignette', strength: 0.5 }),
  grain: () => ({ id: newId(), type: 'grain', amount: 0.3 }),
  chromakey: () => ({ id: newId(), type: 'chromakey', color: '#00FF00', similarity: 0.3, blend: 0.1 }),
  mask: () => ({ id: newId(), type: 'mask', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.6, h: 0.6, feather: 0.05, invert: false }),
  denoise: () => ({ id: newId(), type: 'denoise', reductionDb: 12 }),
}

const sec = (f: number) => (f / FLICKS_PER_SECOND).toFixed(2).replace('.', ',')

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 py-3 border-b border-[var(--color-border)]">
      <h3 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-semibold">{title}</h3>
      {children}
    </section>
  )
}

export function Inspector() {
  const doc = useDoc()
  const selection = useEditor((s) => s.selection)
  const selectedTrackId = useEditor((s) => s.selectedTrackId)
  const found = selection.length === 1 ? findClip(doc, selection[0]!) : null
  if (found) return <ClipInspector clip={found.clip} trackLocked={found.track.locked} />
  if (selection.length > 1) return <p className="p-4 text-sm text-[var(--color-muted)]">{selection.length} clipes selecionados. Use Excluir, ou selecione apenas um para editar.</p>
  const track = doc.tracks.find((t) => t.id === selectedTrackId)
  if (track) return <TrackInspector trackId={track.id} />
  return <ProjectInspector />
}

function ClipInspector({ clip, trackLocked }: { clip: Clip; trackLocked: boolean }) {
  const doc = useDoc()
  const { apply, playhead, assets, workspaceId, upsertAsset, select } = useEditor()
  const toast = useToast()
  const fps = doc.settings.fps
  const local = Math.min(Math.max(0, playhead - clip.start), clip.duration)
  const inside = playhead >= clip.start && playhead < clipEnd(clip)
  const up = (fn: (c: Clip) => void, coalesce?: string) => apply((d) => updateClip(d, clip.id, fn as never), coalesce ? { coalesce: `${clip.id}:${coalesce}` } : undefined)
  const asset = 'assetId' in clip ? assets[clip.assetId] : undefined

  async function derive(op: 'freeze' | 'reverse' | 'extract-audio') {
    if (clip.type !== 'video') return
    try {
      const body = op === 'freeze' ? { op, at: clip.sourceIn + Math.round(local * clip.speed) } : op === 'reverse' ? { op, sourceIn: clip.sourceIn, duration: Math.round(clip.duration * clip.speed) } : { op }
      toast('Processando no servidor…')
      const r = await api<{ assetId: string }>(`/assets/${clip.assetId}/derive`, { body })
      const a = await waitForAsset(r.assetId)
      upsertAsset(a)
      if (op === 'freeze') {
        // divide no cursor e insere um quadro congelado de 2 s na trilha de sobreposição
        const at = quantize(playhead, fps)
        const overlay = doc.tracks.find((t) => t.kind === 'overlay' && !t.clips.some((c) => at < clipEnd(c) && at + secondsToFlicks(2) > c.start))
        if (!overlay) throw new Error('Sem espaço livre na trilha de sobreposição neste ponto.')
        const img = makeMediaClip('image', a.id, at, quantize(secondsToFlicks(2), fps), 'Quadro congelado')
        if (apply((d) => addClip(d, overlay.id, img))) select([img.id])
      } else if (op === 'reverse') {
        apply((d) => {
          const out = replaceClipAsset(d, clip.id, a.id, a.durationFlicks)
          return updateClip(out, clip.id, (c) => {
            if (c.type === 'video') {
              c.speed = 1
              c.name = `${c.name} (invertido)`
            }
          })
        })
      } else {
        const tr = doc.tracks.find((t) => t.kind === 'audio' && !t.clips.some((c) => clip.start < clipEnd(c) && clipEnd(clip) > c.start))
        if (!tr) throw new Error('Sem espaço livre na trilha de áudio.')
        const ac = makeMediaClip('audio', a.id, clip.start, clip.duration, `${clip.name} (áudio)`)
        if (ac.type === 'audio') {
          ac.sourceIn = clip.sourceIn
          ac.speed = clip.speed
        }
        apply((d) => addClip(updateClip(d, clip.id, (c) => { if (c.type === 'video') c.volume = 0 }), tr.id, ac))
      }
      toast('Pronto.', 'ok')
    } catch (err) {
      toast(errorMessage(err), 'danger')
    }
  }

  return (
    <div className="px-4 pb-6 text-sm" aria-label="Propriedades do clipe">
      <Section title="Clipe">
        <Field label="Nome" htmlFor="clip-name">
          <Input id="clip-name" value={clip.name} disabled={trackLocked} onChange={(e) => up((c) => void (c.name = e.target.value.slice(0, 200)), 'name')} />
        </Field>
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <div>
            <div className="text-[var(--color-muted)]">Início</div>
            <div className="tabular-nums">{formatTimecode(clip.start, fps)}</div>
          </div>
          <div>
            <div className="text-[var(--color-muted)]">Duração</div>
            <div className="tabular-nums">{sec(clip.duration)} s</div>
          </div>
        </div>
        {asset && (
          <div className="flex flex-wrap gap-1">
            <Badge>{asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.kind}</Badge>
            {asset.variableFrameRate && <Badge tone="warn">Taxa de quadros variável (normalizada na exportação)</Badge>}
            {asset.rotation ? <Badge tone="info">Rotação {asset.rotation}° aplicada</Badge> : null}
          </div>
        )}
        <Button size="sm" disabled={!inside || trackLocked} onClick={() => apply((d) => splitClip(d, clip.id, playhead))}>
          Dividir no cursor (S)
        </Button>
      </Section>

      {clip.type === 'text' && <TextSection clip={clip} up={up} />}
      {clip.type === 'color' && (
        <Section title="Cor">
          <Field label="Cor de preenchimento" htmlFor="cc">
            <Input id="cc" type="color" value={clip.color.slice(0, 7)} onChange={(e) => up((c) => void (c.type === 'color' && (c.color = e.target.value.toUpperCase())), 'color')} />
          </Field>
        </Section>
      )}

      {clip.type !== 'audio' && (
        <Section title="Transformação e quadros-chave">
          {!inside && <p className="text-[12px] text-[var(--color-muted)]">Posicione o cursor sobre o clipe para criar quadros-chave.</p>}
          {PROPS.map((p) => {
            const pw = keyframePiecewise(clip, p.key)
            const hasKf = clip.keyframes.some((k) => k.property === p.key)
            const value = evalPiecewise(pw, local / FLICKS_PER_SECOND)
            const kfHere = clip.keyframes.find((k) => k.property === p.key && Math.abs(k.time - local) < FLICKS_PER_SECOND / 60)
            return (
              <div key={p.key} className="flex items-end gap-2">
                <div className="flex-1">
                  <Slider
                    label={`${p.label}${hasKf ? ' (animado)' : ''}`}
                    value={value}
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    format={p.fmt}
                    onChange={(v) => {
                      if (hasKf && inside) apply((d) => setKeyframe(d, clip.id, p.key, local, v), { coalesce: `${clip.id}:kf:${p.key}` })
                      else up((c) => void (c.transform[p.key as Exclude<KeyframeProperty, 'volume'>] = v), `tr:${p.key}`)
                    }}
                  />
                </div>
                <button
                  className={`mb-0.5 inline-flex items-center gap-1 h-7 px-1.5 rounded text-[11px] border ${kfHere ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}
                  disabled={!inside || trackLocked}
                  aria-label={kfHere ? `Remover quadro-chave de ${p.label}` : `Adicionar quadro-chave de ${p.label} no cursor`}
                  title={kfHere ? 'Remover quadro-chave' : 'Adicionar quadro-chave no cursor'}
                  onClick={() => (kfHere ? apply((d) => removeKeyframe(d, clip.id, kfHere.id)) : apply((d) => setKeyframe(d, clip.id, p.key, local, value)))}
                >
                  <Diamond size={12} fill={kfHere ? 'currentColor' : 'none'} /> Chave
                </button>
              </div>
            )
          })}
          {clip.type !== 'text' && (
            <div className="flex flex-wrap gap-2">
              <Field label="Ajuste" htmlFor="fit">
                <Select id="fit" value={clip.fit} onChange={(e) => up((c) => void (c.fit = e.target.value as 'cover' | 'contain'))}>
                  <option value="cover">Preencher (corta)</option>
                  <option value="contain">Conter (barras)</option>
                </Select>
              </Field>
              <div className="flex items-end gap-1">
                <Button size="sm" icon={<ZoomIn size={14} />} onClick={() => apply((d) => applyZoom(d, clip.id, 'in'))}>
                  Aproximar (zoom)
                </Button>
                <Button size="sm" icon={<ZoomOut size={14} />} onClick={() => apply((d) => applyZoom(d, clip.id, 'out'))}>
                  Afastar (zoom)
                </Button>
              </div>
            </div>
          )}
          <Field label="Transição de entrada" htmlFor="tin">
            <div className="flex gap-2">
              <Select
                id="tin"
                value={clip.transitionIn?.type ?? 'none'}
                onChange={(e) =>
                  up((c) => {
                    const v = e.target.value
                    c.transitionIn = v === 'none' ? undefined : { type: v as 'fade' | 'dissolve', duration: Math.min(c.duration, quantize(secondsToFlicks(0.5), fps)) }
                  })
                }
              >
                <option value="none">Corte seco</option>
                <option value="fade">Esmaecer</option>
                <option value="dissolve">Dissolver</option>
              </Select>
              {clip.transitionIn && (
                <Input
                  type="number"
                  aria-label="Duração da transição (s)"
                  min={0.1}
                  max={5}
                  step={0.1}
                  className="w-24"
                  value={(clip.transitionIn.duration / FLICKS_PER_SECOND).toFixed(1)}
                  onChange={(e) => up((c) => void (c.transitionIn && (c.transitionIn.duration = Math.min(c.duration, quantize(secondsToFlicks(Number(e.target.value) || 0.1), fps)))))}
                />
              )}
            </div>
          </Field>
        </Section>
      )}

      {(clip.type === 'video' || clip.type === 'audio') && (
        <Section title="Áudio e velocidade">
          <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => up((c) => void ('volume' in c && (c.volume = v)), 'vol')} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Entrada gradual (s)" htmlFor="fi">
              <Input id="fi" type="number" min={0} max={10} step={0.1} value={(clip.fadeIn / FLICKS_PER_SECOND).toFixed(1)} onChange={(e) => up((c) => void ('fadeIn' in c && (c.fadeIn = Math.min(c.duration, quantize(secondsToFlicks(Number(e.target.value) || 0), fps)))))} />
            </Field>
            <Field label="Saída gradual (s)" htmlFor="fo">
              <Input id="fo" type="number" min={0} max={10} step={0.1} value={(clip.fadeOut / FLICKS_PER_SECOND).toFixed(1)} onChange={(e) => up((c) => void ('fadeOut' in c && (c.fadeOut = Math.min(c.duration, quantize(secondsToFlicks(Number(e.target.value) || 0), fps)))))} />
            </Field>
          </div>
          <Field label="Velocidade" htmlFor="spd" hint="Altera a duração do clipe; o tom do áudio é preservado.">
            <Select id="spd" value={String(clip.speed)} onChange={(e) => apply((d) => setClipSpeed(d, clip.id, Number(e.target.value)))}>
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((s) => (
                <option key={s} value={s}>
                  {String(s).replace('.', ',')}×
                </option>
              ))}
              {![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(clip.speed) && <option value={clip.speed}>{clip.speed}×</option>}
            </Select>
          </Field>
          {clip.type === 'video' && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Snowflake size={14} />} disabled={!inside} onClick={() => derive('freeze')}>
                Congelar quadro
              </Button>
              <Button size="sm" icon={<Undo2 size={14} />} onClick={() => derive('reverse')}>
                Inverter (servidor)
              </Button>
              {asset?.hasAudio && (
                <Button size="sm" onClick={() => derive('extract-audio')}>
                  Separar áudio
                </Button>
              )}
            </div>
          )}
          <EffectToggle clip={clip} type="denoise" />
        </Section>
      )}

      {clip.type !== 'audio' && (
        <Section title="Efeitos">
          {clip.effects.filter((e) => e.type !== 'denoise').map((e) => (
            <EffectEditor key={e.id} clip={clip} effect={e} />
          ))}
          <Select
            aria-label="Adicionar efeito"
            value=""
            onChange={(e) => {
              const t = e.target.value as EffectType
              if (t) up((c) => void (c.effects.length < 16 && c.effects.push(EFFECT_DEFAULTS[t]())))
              e.currentTarget.value = ''
            }}
          >
            <option value="">+ Adicionar efeito…</option>
            {(Object.keys(EFFECT_SUPPORT) as EffectType[])
              .filter((t) => t !== 'denoise' && !clip.effects.some((e) => e.type === t))
              .filter((t) => clip.type !== 'text' || t === 'blur')
              .filter((t) => t !== 'mask' || clip.type !== 'text')
              .map((t) => (
                <option key={t} value={t}>
                  {EFFECT_SUPPORT[t].label} {EFFECT_SUPPORT[t].preview === 'approx' ? '(prévia aproximada)' : ''}
                </option>
              ))}
          </Select>
        </Section>
      )}
    </div>
  )
}

function EffectToggle({ clip, type }: { clip: Clip; type: 'denoise' }) {
  const apply = useEditor((s) => s.apply)
  const e = clip.effects.find((x) => x.type === type)
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={!!e} onChange={(ev) => apply((d) => updateClip(d, clip.id, (c) => void (c.effects = ev.target.checked ? [...c.effects, EFFECT_DEFAULTS[type]()] : c.effects.filter((x) => x.type !== type))))} />
        Redução de ruído <Badge>só na exportação</Badge>
      </label>
      {e?.type === 'denoise' && (
        <Slider label="Intensidade (dB)" value={e.reductionDb} min={1} max={40} step={1} format={(v) => `${v} dB`} onChange={(v) => apply((d) => updateClip(d, clip.id, (c) => void c.effects.forEach((x) => x.type === 'denoise' && (x.reductionDb = v))), { coalesce: `${clip.id}:dn` })} />
      )}
    </div>
  )
}

function EffectEditor({ clip, effect }: { clip: Clip; effect: Effect }) {
  const apply = useEditor((s) => s.apply)
  const set = (patch: Record<string, number | string | boolean>) =>
    apply((d) => updateClip(d, clip.id, (c) => void Object.assign(c.effects.find((x) => x.id === effect.id) ?? {}, patch)), { coalesce: `${clip.id}:fx:${effect.id}` })
  const remove = () => apply((d) => updateClip(d, clip.id, (c) => void (c.effects = c.effects.filter((x) => x.id !== effect.id))))
  const sup = EFFECT_SUPPORT[effect.type]
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-[13px] flex-1">{sup.label}</span>
        {sup.preview === 'approx' && <Badge tone="info">prévia aproximada</Badge>}
        <Button size="sm" variant="ghost" onClick={remove} aria-label={`Remover ${sup.label}`}>
          Remover
        </Button>
      </div>
      {effect.type === 'color' && (
        <>
          <Slider label="Brilho" value={effect.brightness} min={-1} max={1} onChange={(v) => set({ brightness: v })} />
          <Slider label="Contraste" value={effect.contrast} min={0} max={3} onChange={(v) => set({ contrast: v })} />
          <Slider label="Saturação" value={effect.saturation} min={0} max={3} onChange={(v) => set({ saturation: v })} />
        </>
      )}
      {effect.type === 'temperature' && <Slider label="Temperatura" value={effect.kelvin} min={2000} max={12000} step={100} format={(v) => `${v} K`} onChange={(v) => set({ kelvin: Math.round(v) })} />}
      {effect.type === 'blur' && <Slider label="Raio" value={effect.radius} min={0} max={40} step={0.5} onChange={(v) => set({ radius: v })} />}
      {effect.type === 'vignette' && <Slider label="Intensidade" value={effect.strength} min={0} max={1} onChange={(v) => set({ strength: v })} />}
      {effect.type === 'grain' && <Slider label="Quantidade" value={effect.amount} min={0} max={1} onChange={(v) => set({ amount: v })} />}
      {effect.type === 'chromakey' && (
        <>
          <Field label="Cor-chave" htmlFor={`ck-${effect.id}`}>
            <Input id={`ck-${effect.id}`} type="color" value={effect.color} onChange={(e) => set({ color: e.target.value.toUpperCase() })} />
          </Field>
          <Slider label="Similaridade" value={effect.similarity} min={0.01} max={1} onChange={(v) => set({ similarity: v })} />
          <Slider label="Suavização" value={effect.blend} min={0} max={1} onChange={(v) => set({ blend: v })} />
        </>
      )}
      {effect.type === 'mask' && (
        <>
          <Field label="Forma" htmlFor={`mk-${effect.id}`}>
            <Select id={`mk-${effect.id}`} value={effect.shape} onChange={(e) => set({ shape: e.target.value })}>
              <option value="ellipse">Elipse</option>
              <option value="rect">Retângulo</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-x-3">
            <Slider label="Centro X" value={effect.x} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ x: v })} />
            <Slider label="Centro Y" value={effect.y} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ y: v })} />
            <Slider label="Largura" value={effect.w} min={0.01} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ w: v })} />
            <Slider label="Altura" value={effect.h} min={0.01} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ h: v })} />
          </div>
          <Slider label="Borda suave" value={effect.feather} min={0} max={0.25} step={0.005} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ feather: v })} />
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={effect.invert} onChange={(e) => set({ invert: e.target.checked })} /> Inverter (esconde o interior)
          </label>
        </>
      )}
    </div>
  )
}

function TextSection({ clip, up }: { clip: Extract<Clip, { type: 'text' }>; up: (fn: (c: Clip) => void, coalesce?: string) => void }) {
  const st = clip.style
  const setStyle = (patch: Partial<TextStyle>, key: string) => up((c) => void (c.type === 'text' && Object.assign(c.style, patch)), `st:${key}`)
  return (
    <Section title="Texto">
      <Field label="Conteúdo" htmlFor="txt" hint={clip.field ? `Campo do modelo: ${clip.field}` : 'Use Enter para quebrar linha.'}>
        <TextArea id="txt" value={clip.text} maxLength={2000} onChange={(e) => up((c) => void (c.type === 'text' && (c.text = e.target.value || ' ')), 'text')} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Fonte" htmlFor="ff">
          <Select id="ff" value={st.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value as TextStyle['fontFamily'] }, 'ff')}>
            <option>Inter</option>
            <option>Inter Display</option>
          </Select>
        </Field>
        <Field label="Peso" htmlFor="fw">
          <Select id="fw" value={st.fontWeight} onChange={(e) => setStyle({ fontWeight: Number(e.target.value) as TextStyle['fontWeight'] }, 'fw')}>
            <option value={400}>Normal</option>
            <option value={600}>Seminegrito</option>
            <option value={700}>Negrito</option>
            <option value={800}>Extranegrito</option>
          </Select>
        </Field>
      </div>
      <Slider label="Tamanho" value={st.fontSize} min={8} max={400} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => setStyle({ fontSize: Math.round(v) }, 'fs')} />
      <div className="grid grid-cols-3 gap-2">
        <Field label="Cor" htmlFor="tc">
          <Input id="tc" type="color" value={st.color.slice(0, 7)} onChange={(e) => setStyle({ color: e.target.value.toUpperCase() }, 'c')} />
        </Field>
        <Field label="Contorno" htmlFor="oc">
          <Input id="oc" type="color" value={st.outlineColor.slice(0, 7)} onChange={(e) => setStyle({ outlineColor: e.target.value.toUpperCase() }, 'oc')} />
        </Field>
        <Field label="Fundo" htmlFor="bg">
          <div className="flex items-center gap-1">
            <input type="checkbox" aria-label="Usar fundo" checked={st.background !== null} onChange={(e) => setStyle({ background: e.target.checked ? '#000000' : null }, 'bgon')} />
            <Input id="bg" type="color" disabled={st.background === null} value={(st.background ?? '#000000').slice(0, 7)} onChange={(e) => setStyle({ background: e.target.value.toUpperCase() }, 'bg')} />
          </div>
        </Field>
      </div>
      <Slider label="Espessura do contorno" value={st.outlineWidth} min={0} max={20} step={0.5} onChange={(v) => setStyle({ outlineWidth: v }, 'ow')} />
      <Slider label="Sombra" value={st.shadow} min={0} max={20} step={0.5} onChange={(v) => setStyle({ shadow: v }, 'sh')} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Alinhamento" htmlFor="al">
          <Select id="al" value={st.align} onChange={(e) => setStyle({ align: e.target.value as TextStyle['align'] }, 'al')}>
            <option value="left">Esquerda</option>
            <option value="center">Centro</option>
            <option value="right">Direita</option>
          </Select>
        </Field>
        <Field label="Animação" htmlFor="an">
          <Select id="an" value={clip.animation} onChange={(e) => up((c) => void (c.type === 'text' && (c.animation = e.target.value as typeof clip.animation)))}>
            <option value="none">Nenhuma</option>
            <option value="fade">Esmaecer</option>
            <option value="slide-up">Subir</option>
            <option value="pop">Saltar</option>
          </Select>
        </Field>
      </div>
    </Section>
  )
}

function TrackInspector({ trackId }: { trackId: string }) {
  const doc = useDoc()
  const apply = useEditor((s) => s.apply)
  const track = doc.tracks.find((t) => t.id === trackId)!
  return (
    <div className="px-4 pb-6 text-sm">
      <Section title={`Trilha — ${track.name}`}>
        <Field label="Nome" htmlFor="tn">
          <Input id="tn" value={track.name} onChange={(e) => apply((d) => setTrackFlags(d, trackId, { name: e.target.value.slice(0, 80) }), { coalesce: `tn:${trackId}` })} />
        </Field>
        {track.kind !== 'text' && <Slider label="Volume da trilha" value={track.volume} min={0} max={2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => apply((d) => setTrackFlags(d, trackId, { volume: v }), { coalesce: `tv:${trackId}` })} />}
        {track.kind === 'music' && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={track.duckUnderVoice} onChange={(e) => apply((d) => setTrackFlags(d, trackId, { duckUnderVoice: e.target.checked }))} />
            Abaixar automaticamente durante a narração
          </label>
        )}
        <p className="text-[12px] text-[var(--color-muted)]">Solo e silenciar afetam o áudio; ocultar afeta a imagem. Trilhas bloqueadas não aceitam edição.</p>
      </Section>
    </div>
  )
}

function ProjectInspector() {
  const doc = useDoc()
  const apply = useEditor((s) => s.apply)
  const hasClips = doc.tracks.some((t) => t.clips.length > 0)
  const setSettings = (patch: Partial<TimelineDoc['settings']>) => apply((d) => ({ ...d, settings: { ...d.settings, ...patch } }))
  return (
    <div className="px-4 pb-6 text-sm">
      <Section title="Projeto">
        <Field label="Formato" htmlFor="asp" hint="Alterar o formato mantém as posições relativas dos elementos.">
          <Select
            id="asp"
            value={doc.settings.aspect}
            onChange={(e) => {
              const a = e.target.value as TimelineDoc['settings']['aspect']
              if (a === 'custom') setSettings({ aspect: a })
              else setSettings({ aspect: a, ...ASPECT_DIMENSIONS[a] })
            }}
          >
            <option value="9:16">9:16 Vertical</option>
            <option value="16:9">16:9 Horizontal</option>
            <option value="1:1">1:1 Quadrado</option>
            <option value="4:5">4:5 Retrato</option>
            <option value="custom">Personalizado</option>
          </Select>
        </Field>
        {doc.settings.aspect === 'custom' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Largura" htmlFor="pw">
              <Input id="pw" type="number" min={144} max={3840} step={2} value={doc.settings.width} onChange={(e) => setSettings({ width: Math.min(3840, Math.max(144, Math.round(Number(e.target.value) / 2) * 2)) })} />
            </Field>
            <Field label="Altura" htmlFor="ph">
              <Input id="ph" type="number" min={144} max={3840} step={2} value={doc.settings.height} onChange={(e) => setSettings({ height: Math.min(3840, Math.max(144, Math.round(Number(e.target.value) / 2) * 2)) })} />
            </Field>
          </div>
        )}
        <div className="text-[12px] text-[var(--color-muted)]">
          {doc.settings.width}×{doc.settings.height} · {(doc.settings.fps.num / doc.settings.fps.den).toFixed(3).replace(/\.?0+$/, '').replace('.', ',')} fps {hasClips && '(taxa de quadros fixa após adicionar clipes)'}
        </div>
        <Field label="Cor de fundo" htmlFor="pbg">
          <Input id="pbg" type="color" value={doc.settings.background.slice(0, 7)} onChange={(e) => setSettings({ background: e.target.value.toUpperCase() })} />
        </Field>
      </Section>
      <p className="text-[12px] text-[var(--color-muted)] pt-3">Selecione um clipe para editar posição, quadros-chave, velocidade, efeitos e transições.</p>
    </div>
  )
}
