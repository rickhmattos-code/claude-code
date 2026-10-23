'use client'
import type { BrandKitBody } from '@orion/shared'
import { Button, Empty, Field, Input, Select, useToast } from '@orion/ui'
import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AssetPicker } from '@/components/AssetPicker'
import { api, errorMessage } from '@/lib/api'
import { useSession } from '@/lib/session'

type Kit = BrandKitBody & { id: string }
const EMPTY: BrandKitBody = {
  name: 'Minha marca',
  displayName: 'Luís Henrique de Matos',
  socialHandle: '@ovendedordeaco08',
  signature: '',
  palette: { primary: '#F2A93B', secondary: '#6E8BFF', background: '#0F1220', text: '#FFFFFF' },
  fonts: { heading: 'Inter Display', body: 'Inter' },
  captionStyleOverrides: { highlightColor: '#F2A93B' },
  logoAssetId: null,
  watermarkAssetId: null,
  introAssetId: null,
  outroAssetId: null,
}

export default function BrandPage() {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const [kits, setKits] = useState<Kit[]>([])
  const [edit, setEdit] = useState<(BrandKitBody & { id?: string }) | null>(null)
  const load = useCallback(() => api<Kit[]>(`/workspaces/${ws.id}/brand-kits`).then(setKits).catch((e) => toast(errorMessage(e), 'danger')), [ws.id, toast])
  useEffect(() => {
    void load()
  }, [load])
  async function save() {
    if (!edit) return
    try {
      const { id, ...body } = edit
      if (id) await api(`/brand-kits/${id}`, { method: 'PUT', body })
      else await api(`/workspaces/${ws.id}/brand-kits`, { body })
      toast('Kit de marca salvo.', 'ok')
      setEdit(null)
      void load()
    } catch (err) {
      toast(errorMessage(err), 'danger')
    }
  }
  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-5">
      <header className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold">Identidade visual</h1>
          <p className="text-sm text-[var(--color-muted)]">Logotipo, paleta, fontes licenciadas (Inter, OFL), assinatura, marca-d’água, vinhetas e estilo de legenda — aplicáveis em lote nos projetos.</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEdit({ ...EMPTY })}>Novo kit</Button>
      </header>
      {!edit && (kits.length === 0 ? <Empty title="Nenhum kit de marca" action={<Button variant="primary" onClick={() => setEdit({ ...EMPTY })}>Criar kit</Button>} /> : (
        <ul className="grid sm:grid-cols-2 gap-3">
          {kits.map((k) => (
            <li key={k.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-2">
              <div className="flex gap-1">{Object.values(k.palette).map((c) => <span key={c} className="w-6 h-6 rounded-full border border-white/10" style={{ background: c }} />)}</div>
              <div className="font-medium">{k.name}</div>
              <div className="text-sm">{k.displayName} <span className="text-[var(--color-muted)]">{k.socialHandle}</span></div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setEdit({ ...k })}>Editar</Button>
                <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={async () => { if (confirm('Excluir kit?')) { await api(`/brand-kits/${k.id}`, { method: 'DELETE' }); void load() } }}>Excluir</Button>
              </div>
            </li>
          ))}
        </ul>
      ))}
      {edit && (
        <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 grid md:grid-cols-2 gap-4">
          <Field label="Nome do kit" htmlFor="bn"><Input id="bn" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Nome exibido" htmlFor="bd" hint="Ex.: Luís Henrique de Matos"><Input id="bd" value={edit.displayName} onChange={(e) => setEdit({ ...edit, displayName: e.target.value })} /></Field>
          <Field label="Perfil social" htmlFor="bs" hint="Ex.: @ovendedordeaco08"><Input id="bs" value={edit.socialHandle ?? ''} onChange={(e) => setEdit({ ...edit, socialHandle: e.target.value })} /></Field>
          <Field label="Assinatura (opcional)" htmlFor="bsg"><Input id="bsg" value={edit.signature ?? ''} onChange={(e) => setEdit({ ...edit, signature: e.target.value })} /></Field>
          <fieldset className="md:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <legend className="text-[12px] text-[var(--color-muted)] mb-1">Paleta</legend>
            {(['primary', 'secondary', 'background', 'text'] as const).map((k) => (
              <Field key={k} label={{ primary: 'Primária', secondary: 'Secundária', background: 'Fundo', text: 'Texto' }[k]} htmlFor={`pal-${k}`}>
                <Input id={`pal-${k}`} type="color" value={edit.palette[k]} onChange={(e) => setEdit({ ...edit, palette: { ...edit.palette, [k]: e.target.value.toUpperCase() } })} />
              </Field>
            ))}
          </fieldset>
          <Field label="Fonte de títulos" htmlFor="fh"><Select id="fh" value={edit.fonts.heading} onChange={(e) => setEdit({ ...edit, fonts: { ...edit.fonts, heading: e.target.value as 'Inter' } })}><option>Inter Display</option><option>Inter</option></Select></Field>
          <Field label="Fonte de texto/legendas" htmlFor="fb"><Select id="fb" value={edit.fonts.body} onChange={(e) => setEdit({ ...edit, fonts: { ...edit.fonts, body: e.target.value as 'Inter' } })}><option>Inter</option><option>Inter Display</option></Select></Field>
          <Field label="Cor de destaque das legendas" htmlFor="ch"><Input id="ch" type="color" value={edit.captionStyleOverrides.highlightColor ?? edit.palette.primary} onChange={(e) => setEdit({ ...edit, captionStyleOverrides: { ...edit.captionStyleOverrides, highlightColor: e.target.value.toUpperCase() } })} /></Field>
          <div />
          <AssetPicker id="logo" label="Logotipo" kinds={['IMAGE']} value={edit.logoAssetId} onChange={(v) => setEdit({ ...edit, logoAssetId: v })} />
          <AssetPicker id="wm" label="Marca-d’água (PNG com transparência)" kinds={['IMAGE']} value={edit.watermarkAssetId} onChange={(v) => setEdit({ ...edit, watermarkAssetId: v })} />
          <AssetPicker id="intro" label="Vinheta de abertura" kinds={['VIDEO', 'IMAGE']} value={edit.introAssetId} onChange={(v) => setEdit({ ...edit, introAssetId: v })} />
          <AssetPicker id="outro" label="Vinheta de encerramento" kinds={['VIDEO', 'IMAGE']} value={edit.outroAssetId} onChange={(v) => setEdit({ ...edit, outroAssetId: v })} />
          <div className="md:col-span-2 flex justify-end gap-2">
            <Button onClick={() => setEdit(null)}>Cancelar</Button>
            <Button variant="primary" onClick={save}>Salvar kit</Button>
          </div>
        </section>
      )}
    </div>
  )
}
