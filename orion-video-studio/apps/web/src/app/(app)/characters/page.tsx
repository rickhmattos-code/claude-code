'use client'
import type { CharacterBody } from '@orion/shared'
import { Badge, Button, Empty, Field, Input, Select, TextArea, useToast } from '@orion/ui'
import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AssetPicker } from '@/components/AssetPicker'
import { api, errorMessage } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { AssetDto, GenerationDto } from '@/lib/types'

type Character = Omit<CharacterBody, 'references'> & { id: string; references: Array<{ assetId: string; authorization: string; asset: AssetDto }> }
const EMPTY: CharacterBody = { name: '', description: '', appearance: '', wardrobe: '', palette: [], mustKeep: [], continuityRules: '', voiceProfileId: null, references: [] }

export default function CharactersPage() {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const [list, setList] = useState<Character[]>([])
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([])
  const [gens, setGens] = useState<GenerationDto[]>([])
  const [results, setResults] = useState<Record<string, AssetDto>>({})
  const [edit, setEdit] = useState<(CharacterBody & { id?: string }) | null>(null)
  const [newRef, setNewRef] = useState<{ assetId: string | null; authorization: string }>({ assetId: null, authorization: '' })
  const load = useCallback(async () => {
    setList(await api<Character[]>(`/workspaces/${ws.id}/characters`))
    setVoices(await api<typeof voices>(`/workspaces/${ws.id}/voice-profiles`))
    const g = (await api<GenerationDto[]>(`/workspaces/${ws.id}/generations`)).filter((x) => (x.kind === 'IMAGE' || x.kind === 'VIDEO') && x.status === 'succeeded' && Array.isArray(x.input.characterIds) && (x.input.characterIds as string[]).length)
    setGens(g)
    if (g.length) {
      const assets = await api<AssetDto[]>('/assets/batch', { body: { ids: g.map((x) => x.resultAssetId).filter(Boolean) } })
      setResults(Object.fromEntries(assets.map((a) => [a.id, a])))
    }
  }, [ws.id])
  useEffect(() => {
    load().catch((e) => toast(errorMessage(e), 'danger'))
  }, [load, toast])
  async function save() {
    if (!edit) return
    try {
      const { id, ...body } = edit
      if (id) await api(`/characters/${id}`, { method: 'PUT', body })
      else await api(`/workspaces/${ws.id}/characters`, { body })
      setEdit(null)
      toast('Personagem salvo.', 'ok')
      void load()
    } catch (err) {
      toast(errorMessage(err), 'danger')
    }
  }
  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-5">
      <header className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold">Personagens</h1>
          <p className="text-sm text-[var(--color-muted)]">Fichas reutilizadas nos prompts das cenas. Os modelos não garantem preservação absoluta de identidade: compare, aprove ou regenere.</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEdit({ ...EMPTY })}>Novo personagem</Button>
      </header>
      {edit ? (
        <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 grid md:grid-cols-2 gap-4">
          <Field label="Nome" htmlFor="cn"><Input id="cn" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Voz associada" htmlFor="cv"><Select id="cv" value={edit.voiceProfileId ?? ''} onChange={(e) => setEdit({ ...edit, voiceProfileId: e.target.value || null })}><option value="">Nenhuma</option>{voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
          <Field label="Descrição" htmlFor="cd"><TextArea id="cd" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <Field label="Aparência" htmlFor="ca"><TextArea id="ca" value={edit.appearance} onChange={(e) => setEdit({ ...edit, appearance: e.target.value })} placeholder="Idade aparente, cabelo, rosto, porte" /></Field>
          <Field label="Figurino" htmlFor="cw"><TextArea id="cw" value={edit.wardrobe} onChange={(e) => setEdit({ ...edit, wardrobe: e.target.value })} /></Field>
          <Field label="Restrições de enquadramento e continuidade" htmlFor="cr"><TextArea id="cr" value={edit.continuityRules} onChange={(e) => setEdit({ ...edit, continuityRules: e.target.value })} placeholder="Ex.: sempre de perfil esquerdo; cicatriz visível" /></Field>
          <Field label="Características que precisam permanecer (uma por linha)" htmlFor="ck"><TextArea id="ck" value={edit.mustKeep.join('\n')} onChange={(e) => setEdit({ ...edit, mustKeep: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12) })} /></Field>
          <Field label="Paleta (hex separados por vírgula)" htmlFor="cp"><Input id="cp" value={edit.palette.join(', ')} onChange={(e) => setEdit({ ...edit, palette: e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^#[0-9A-F]{6}$/.test(s)).slice(0, 8) })} /></Field>
          <div className="md:col-span-2 flex flex-col gap-2">
            <h3 className="font-medium">Imagens de referência autorizadas</h3>
            <div className="flex gap-2 flex-wrap">
              {edit.references.map((r) => {
                const asset = list.flatMap((c) => c.references).find((x) => x.assetId === r.assetId)?.asset
                return (
                  <figure key={r.assetId} className="w-28 flex flex-col gap-1">
                    {asset?.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="Referência" className="w-28 h-28 rounded object-cover" /> : <div className="w-28 h-28 rounded bg-[var(--color-surface-2)]" />}
                    <figcaption className="text-[10px] text-[var(--color-muted)] line-clamp-2">{r.authorization}</figcaption>
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ ...edit, references: edit.references.filter((x) => x.assetId !== r.assetId) })}>Remover</Button>
                  </figure>
                )
              })}
            </div>
            <div className="grid md:grid-cols-2 gap-2 items-end">
              <AssetPicker id="ref" label="Adicionar referência" kinds={['IMAGE']} value={newRef.assetId} onChange={(v) => setNewRef({ ...newRef, assetId: v })} />
              <Field label="Declaração de autorização de uso da imagem" htmlFor="au"><Input id="au" value={newRef.authorization} onChange={(e) => setNewRef({ ...newRef, authorization: e.target.value })} placeholder="Ex.: Imagem própria; autorizada por ... em ..." /></Field>
            </div>
            <Button size="sm" disabled={!newRef.assetId || newRef.authorization.length < 5 || edit.references.length >= 8} onClick={() => { setEdit({ ...edit, references: [...edit.references, { assetId: newRef.assetId!, authorization: newRef.authorization }] }); setNewRef({ assetId: null, authorization: '' }) }}>Incluir referência</Button>
          </div>
          <div className="md:col-span-2 flex justify-end gap-2">
            <Button onClick={() => setEdit(null)}>Cancelar</Button>
            <Button variant="primary" disabled={!edit.name} onClick={save}>Salvar personagem</Button>
          </div>
        </section>
      ) : list.length === 0 ? (
        <Empty title="Nenhum personagem" action={<Button variant="primary" onClick={() => setEdit({ ...EMPTY })}>Criar personagem</Button>}>Personagens recorrentes mantêm descrição, figurino e referências entre episódios.</Empty>
      ) : (
        <ul className="flex flex-col gap-4">
          {list.map((c) => {
            const mine = gens.filter((g) => (g.input.characterIds as string[]).includes(c.id))
            return (
              <li key={c.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <h2 className="font-semibold">{c.name}</h2>
                    <p className="text-[13px] text-[var(--color-muted)]">{c.appearance}</p>
                    <div className="flex gap-1 flex-wrap mt-1">{c.mustKeep.map((m) => <Badge key={m}>{m}</Badge>)}</div>
                  </div>
                  <Button size="sm" onClick={() => setEdit({ id: c.id, name: c.name, description: c.description, appearance: c.appearance, wardrobe: c.wardrobe, palette: c.palette, mustKeep: c.mustKeep, continuityRules: c.continuityRules, voiceProfileId: c.voiceProfileId, references: c.references.map((r) => ({ assetId: r.assetId, authorization: r.authorization })) })}>Editar</Button>
                  <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={async () => { if (confirm('Excluir personagem?')) { await api(`/characters/${c.id}`, { method: 'DELETE' }); void load() } }}>Excluir</Button>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-1" aria-label="Referência × resultados">
                  {c.references.map((r) => (
                    <figure key={r.assetId} className="shrink-0">
                      <img src={r.asset.thumbnailUrl ?? r.asset.originalUrl ?? ''} alt={`Referência de ${c.name}`} className="w-28 h-28 rounded object-cover border-2 border-[var(--color-blue)]" />
                      <figcaption className="text-[10px] text-[var(--color-blue)]">Referência</figcaption>
                    </figure>
                  ))}
                  {mine.map((g) => {
                    const a = results[g.resultAssetId ?? '']
                    return (
                      <figure key={g.id} className="shrink-0">
                        <img src={a?.thumbnailUrl ?? a?.originalUrl ?? ''} alt="Resultado gerado" className={`w-28 h-28 rounded object-cover border-2 ${g.approved ? 'border-[var(--color-ok)]' : 'border-[var(--color-border)]'}`} />
                        <figcaption className="flex gap-1 text-[10px]">
                          <button className="underline" onClick={async () => { await api(`/generations/${g.id}/approve`, { body: { approved: !g.approved } }); void load() }}>{g.approved ? 'Aprovado ✓' : 'Aprovar'}</button>
                        </figcaption>
                      </figure>
                    )
                  })}
                  {!mine.length && <p className="text-[12px] text-[var(--color-muted)] self-center">Nenhuma geração com este personagem ainda (use Cenas IA no editor).</p>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
