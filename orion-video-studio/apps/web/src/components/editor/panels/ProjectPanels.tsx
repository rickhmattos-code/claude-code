'use client'
import type { BrandKitBody, TimelineDoc } from '@orion/shared'
import { type BrandApplyOptions, type StructuredCommand, applyBrandKit, diffSummary, executeCommand, setTemplateField, templateFromDocument } from '@orion/timeline'
import { Badge, Button, Field, Input, Select, TextArea, useToast } from '@orion/ui'
import { Palette, Send, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { AssetDto } from '@/lib/types'
import { useDoc, useEditor } from '../store'

// ---------------------------------------------------------------- templates
export function TemplatesPanel() {
  const doc = useDoc()
  const { apply, workspaceId, name } = useEditor()
  const toast = useToast()
  const fields = new Map<string, string>()
  for (const t of doc.tracks) for (const c of t.clips) if (c.type === 'text' && c.field && !fields.has(c.field)) fields.set(c.field, c.text)
  const [slug, setSlug] = useState(name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'meu-template')
  async function saveAsTemplate() {
    try {
      const def = templateFromDocument(doc, { slug, name, description: `Criado a partir do projeto “${name}”.` })
      const r = await api<{ version: number }>(`/workspaces/${workspaceId}/templates`, { body: { definition: def } })
      toast(`Template salvo (versão ${r.version}).`, 'ok')
    } catch (err) {
      toast(errorMessage(err), 'danger')
    }
  }
  return (
    <div className="p-3 flex flex-col gap-3 text-sm">
      {doc.meta.templateSlug ? (
        <p className="text-[12px] text-[var(--color-muted)]">
          Template: <Badge>{doc.meta.templateSlug} v{doc.meta.templateVersion}</Badge>
        </p>
      ) : (
        <p className="text-[12px] text-[var(--color-muted)]">Projeto livre. Para começar de um template, use a Galeria de templates na tela inicial.</p>
      )}
      {fields.size > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Campos substituíveis</h3>
          {[...fields.entries()].map(([k, v]) => (
            <Field key={k} label={k} htmlFor={`fld-${k}`}>
              <TextArea id={`fld-${k}`} className="min-h-[44px]" value={v} onChange={(e) => apply((d) => setTemplateField(d, k, e.target.value || ' '), { coalesce: `fld:${k}` })} />
            </Field>
          ))}
        </section>
      )}
      <section className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2">
        <h3 className="font-medium">Salvar este projeto como template</h3>
        <Field label="Identificador" htmlFor="tslug" hint="Letras minúsculas, números e hífens. Salvar de novo cria uma nova versão.">
          <Input id="tslug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
        </Field>
        <Button onClick={saveAsTemplate} disabled={slug.length < 2}>
          Salvar template
        </Button>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- marca
type BrandKit = BrandKitBody & { id: string }

export function useApplyBrand() {
  const { apply, upsertAsset } = useEditor()
  const toast = useToast()
  return async (kit: BrandKit, opts: BrandApplyOptions) => {
    const ids = [kit.logoAssetId, kit.watermarkAssetId, kit.introAssetId, kit.outroAssetId].filter((x): x is string => !!x)
    const list = ids.length ? await api<AssetDto[]>('/assets/batch', { body: { ids } }) : []
    list.forEach(upsertAsset)
    const by = new Map(list.map((a) => [a.id, a]))
    const asMedia = (id?: string | null) => {
      const a = id ? by.get(id) : undefined
      return a ? { assetId: a.id, type: (a.kind === 'IMAGE' ? 'image' : 'video') as 'image' | 'video', durationFlicks: a.durationFlicks ?? 0 } : undefined
    }
    const wm = kit.watermarkAssetId ?? kit.logoAssetId
    const ok = apply((d) =>
      applyBrandKit(d, kit, { watermark: wm ? { assetId: wm } : undefined, intro: asMedia(kit.introAssetId), outro: asMedia(kit.outroAssetId) }, opts),
    )
    if (ok) toast(`Identidade “${kit.name}” aplicada. Use Desfazer para reverter.`, 'ok')
  }
}

export function BrandPanel() {
  const { workspaceId } = useEditor()
  const toast = useToast()
  const applyBrand = useApplyBrand()
  const [kits, setKits] = useState<BrandKit[]>([])
  const [kitId, setKitId] = useState('')
  const [opts, setOpts] = useState<BrandApplyOptions>({ textColors: true, captions: true, watermark: true, intro: true, outro: true, signature: true })
  useEffect(() => {
    api<BrandKit[]>(`/workspaces/${workspaceId}/brand-kits`)
      .then((k) => {
        setKits(k)
        setKitId(k[0]?.id ?? '')
      })
      .catch((e) => toast(errorMessage(e), 'danger'))
  }, [workspaceId, toast])
  const kit = kits.find((k) => k.id === kitId)
  const labels: Record<keyof BrandApplyOptions, string> = { textColors: 'Cores e fontes dos textos', captions: 'Estilo das legendas', watermark: 'Marca-d’água/logotipo', intro: 'Vinheta de abertura', outro: 'Vinheta de encerramento', signature: 'Assinatura (nome e perfil) no final' }
  return (
    <div className="p-3 flex flex-col gap-3 text-sm">
      {kits.length === 0 ? (
        <p className="text-[12px] text-[var(--color-muted)]">
          Nenhum kit de marca. Crie em <a className="underline text-[var(--color-blue)]" href="/brand">Identidade visual</a>.
        </p>
      ) : (
        <>
          <Select aria-label="Kit de marca" value={kitId} onChange={(e) => setKitId(e.target.value)}>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </Select>
          {kit && (
            <div className="rounded-lg border border-[var(--color-border)] p-3 flex items-center gap-3">
              <div className="flex gap-1">
                {Object.values(kit.palette).map((c) => (
                  <span key={c} className="w-5 h-5 rounded-full border border-white/10" style={{ background: c }} aria-label={c} />
                ))}
              </div>
              <div className="min-w-0">
                <div className="font-medium truncate">{kit.displayName}</div>
                <div className="text-[12px] text-[var(--color-muted)] truncate">{kit.socialHandle}</div>
              </div>
            </div>
          )}
          {(Object.keys(labels) as Array<keyof BrandApplyOptions>).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {labels[k]}
            </label>
          ))}
          <Button variant="primary" icon={<Palette size={16} />} disabled={!kit} onClick={() => kit && applyBrand(kit, opts)}>
            Aplicar identidade
          </Button>
          <p className="text-[11px] text-[var(--color-muted)]">Reaplicar substitui os elementos de marca anteriores (não duplica).</p>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- assistente
export function AssistantPanel({ onOpenTab }: { onOpenTab: (tab: 'voice') => void }) {
  const doc = useDoc()
  const { workspaceId, selection, playhead, apply } = useEditor()
  const toast = useToast()
  const applyBrand = useApplyBrand()
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ commands: StructuredCommand[]; summary: string; lines: string[]; next: TimelineDoc | null; source: string; requiresPaid: boolean } | null>(null)
  const examples = ['Troque a música', 'Encurte a introdução em 2 segundos', 'Divida esta cena', 'Mude a voz', 'Aplique minha identidade visual', 'Diminua o volume da música']
  async function ask(text: string) {
    setBusy(true)
    try {
      const r = await api<{ commands: StructuredCommand[]; summary: string; understood: boolean; requiresPaidGeneration: boolean; source: string }>(`/workspaces/${workspaceId}/assistant/command`, { body: { command: text, document: doc, selectedClipId: selection[0], playhead } })
      if (!r.understood) {
        setPreview(null)
        toast(r.summary, 'info')
        return
      }
      let next: TimelineDoc | null = doc
      for (const c of r.commands) {
        if (c.type === 'applyBrandKit' || c.type === 'changeVoice') {
          next = null
          break
        }
        next = executeCommand(next!, c)
      }
      setPreview({ commands: r.commands, summary: r.summary, lines: next ? diffSummary(doc, next) : [], next, source: r.source, requiresPaid: r.requiresPaidGeneration })
    } catch (err) {
      toast(errorMessage(err), 'danger')
    } finally {
      setBusy(false)
    }
  }
  async function confirm() {
    if (!preview) return
    const special = preview.commands.find((c) => c.type === 'applyBrandKit' || c.type === 'changeVoice')
    if (special?.type === 'applyBrandKit') {
      const kits = await api<Array<BrandKitBody & { id: string }>>(`/workspaces/${workspaceId}/brand-kits`)
      const kit = kits.find((k) => k.id === special.brandKitId)
      if (kit) await applyBrand(kit, { textColors: true, captions: true, watermark: true, intro: true, outro: true, signature: true })
    } else if (special?.type === 'changeVoice') {
      onOpenTab('voice')
      toast('Escolha a nova voz no Estúdio de Voz e regenere as frases (o custo é estimado antes).', 'info')
    } else if (preview.next) {
      const target = preview.next
      apply(() => target)
      toast('Alterações aplicadas. Desfazer: Ctrl+Z.', 'ok')
    }
    setPreview(null)
    setCommand('')
  }
  return (
    <div className="p-3 flex flex-col gap-3 text-sm">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (command.trim()) void ask(command)
        }}
      >
        <Field label="O que você quer mudar?" htmlFor="cmd">
          <Input id="cmd" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Ex.: encurte a introdução" />
        </Field>
        <Button type="submit" variant="primary" icon={<Send size={14} />} loading={busy}>
          Ver prévia das alterações
        </Button>
      </form>
      <div className="flex flex-wrap gap-1">
        {examples.map((x) => (
          <button key={x} className="text-[11px] rounded-full border border-[var(--color-border)] px-2 py-1 hover:border-[var(--color-accent)]" onClick={() => { setCommand(x); void ask(x) }}>
            {x}
          </button>
        ))}
      </div>
      {preview && (
        <section className="rounded-lg border border-[var(--color-accent)]/50 p-3 flex flex-col gap-2" aria-live="polite">
          <h3 className="font-medium flex items-center gap-1">
            <Sparkles size={14} /> Prévia {preview.source === 'llm' ? <Badge tone="info">interpretado por IA</Badge> : <Badge>regra local</Badge>}
          </h3>
          <p>{preview.summary}</p>
          {preview.lines.length > 0 && (
            <ul className="text-[12px] text-[var(--color-muted)] list-disc pl-4">
              {preview.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          <pre className="text-[10px] bg-[var(--color-bg)] rounded p-2 overflow-auto max-h-32">{JSON.stringify(preview.commands, null, 1)}</pre>
          <div className="flex gap-2">
            <Button onClick={() => setPreview(null)}>Cancelar</Button>
            <Button variant="primary" onClick={confirm}>
              {preview.requiresPaid ? 'Continuar (custo será estimado)' : 'Aplicar'}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
