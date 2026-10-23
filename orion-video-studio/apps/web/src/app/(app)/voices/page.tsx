'use client'
import { Badge, Button, Empty, Field, Input, Select, Slider, TextArea, useToast } from '@orion/ui'
import { Mic, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useGeneration } from '@/components/editor/useGeneration'
import { api, errorMessage } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { AssetDto, ProvidersDto } from '@/lib/types'

interface VoiceProfile {
  id: string
  name: string
  provider: string
  providerVoiceId: string
  language: string
  settings: { speed?: number; pronunciation?: Record<string, string> }
  isClone: boolean
}

export default function VoicesPage() {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const { run, dialog, busy } = useGeneration(ws.id)
  const [providers, setProviders] = useState<ProvidersDto | null>(null)
  const [provider, setProvider] = useState('')
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string; previewUrl: string | null; language: string | null }>>([])
  const [profiles, setProfiles] = useState<VoiceProfile[]>([])
  const [form, setForm] = useState({ name: '', voiceId: '', speed: 1, pron: 'ORION=Órion', isClone: false, speakerName: '', grantedBy: '', statement: '' })
  const [phrase, setPhrase] = useState('Olá! Esta é uma prévia da narração em português do Brasil.')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const loadProfiles = useCallback(() => api<VoiceProfile[]>(`/workspaces/${ws.id}/voice-profiles`).then(setProfiles).catch(() => undefined), [ws.id])
  useEffect(() => {
    api<ProvidersDto>('/providers').then((p) => {
      setProviders(p)
      setProvider(p.tts.find((x) => x.configured)?.id ?? '')
    })
    void loadProfiles()
  }, [loadProfiles])
  useEffect(() => {
    if (!provider) return
    api<{ voices: typeof catalog }>(`/voices/catalog?provider=${provider}`)
      .then((r) => {
        setCatalog(r.voices)
        setForm((f) => ({ ...f, voiceId: f.voiceId || r.voices[0]?.id || '' }))
      })
      .catch((e) => toast(errorMessage(e), 'danger'))
  }, [provider, toast])
  const adapter = providers?.tts.find((p) => p.id === provider)
  const parsePron = (s: string) => Object.fromEntries(s.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]) as Array<[string, string]>)

  async function preview() {
    if (!adapter) return
    const [g] = await run([{ kind: 'TTS', provider: adapter.id, model: adapter.models[0]!.id, voiceId: form.voiceId, text: phrase, speed: form.speed }], 'Prévia de um trecho de narração.')
    if (!g) return
    if (g.status !== 'succeeded') return toast(g.error ?? 'Falha', 'danger')
    const [a] = await api<AssetDto[]>('/assets/batch', { body: { ids: [g.resultAssetId] } })
    setPreviewUrl(a?.originalUrl ?? null)
  }
  async function save() {
    try {
      await api(`/workspaces/${ws.id}/voice-profiles`, {
        body: {
          name: form.name,
          provider,
          providerVoiceId: form.voiceId,
          settings: { speed: form.speed },
          pronunciation: parsePron(form.pron),
          isClone: form.isClone,
          ...(form.isClone ? { consent: { speakerName: form.speakerName, grantedBy: form.grantedBy, grantedAt: new Date().toISOString(), statement: form.statement } } : {}),
        },
      })
      toast('Voz salva.', 'ok')
      void loadProfiles()
    } catch (err) {
      toast(errorMessage(err), 'danger')
    }
  }
  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-5">
      {dialog}
      <header>
        <h1 className="font-display text-2xl font-bold">Estúdio de voz</h1>
        <p className="text-sm text-[var(--color-muted)]">Vozes do provedor, prévia de trechos, dicionário de pronúncia e registro de autorização para vozes clonadas.</p>
      </header>
      {!adapter ? (
        <Empty title="Nenhum provedor de voz configurado">
          <Badge tone="warn">Configuração pendente</Badge> Defina ELEVENLABS_API_KEY no servidor. Enquanto isso, grave ou envie sua narração no editor (aba Mídia → Gravar narração).
        </Empty>
      ) : (
        <div className="grid md:grid-cols-2 gap-5">
          <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 flex flex-col gap-3">
            <h2 className="font-semibold flex items-center gap-2"><Mic size={16} /> Configurar voz</h2>
            <Field label="Provedor" htmlFor="vp">
              <Select id="vp" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {providers!.tts.filter((p) => p.configured).map((p) => <option key={p.id} value={p.id}>{p.label} {p.mode === 'mock' ? '(teste)' : ''}</option>)}
              </Select>
            </Field>
            <Field label="Voz do catálogo" htmlFor="vv">
              <Select id="vv" value={form.voiceId} onChange={(e) => setForm({ ...form, voiceId: e.target.value })}>
                {catalog.map((v) => <option key={v.id} value={v.id}>{v.name}{v.language ? ` (${v.language})` : ''}</option>)}
              </Select>
            </Field>
            <Slider label="Velocidade" value={form.speed} min={adapter.models[0]!.speedRange[0]} max={adapter.models[0]!.speedRange[1]} step={0.05} format={(v) => `${v.toFixed(2).replace('.', ',')}×`} onChange={(v) => setForm({ ...form, speed: v })} />
            <Field label="Trecho para prévia" htmlFor="ph"><TextArea id="ph" value={phrase} onChange={(e) => setPhrase(e.target.value)} /></Field>
            <Button icon={<Play size={14} />} loading={busy} onClick={preview}>Ouvir prévia (custo estimado antes)</Button>
            {previewUrl && <audio src={previewUrl} controls className="w-full" aria-label="Prévia da voz" />}
            <Field label="Dicionário de pronúncia" htmlFor="pr" hint="Uma regra por linha: TERMO=como falar. Aplicado ao texto antes do envio, em qualquer provedor.">
              <TextArea id="pr" value={form.pron} onChange={(e) => setForm({ ...form, pron: e.target.value })} />
            </Field>
            <Field label="Nome desta voz no projeto" htmlFor="vn"><Input id="vn" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Narrador principal" /></Field>
            <label className="flex gap-2 items-center"><input type="checkbox" checked={form.isClone} onChange={(e) => setForm({ ...form, isClone: e.target.checked })} /> É uma voz clonada de uma pessoa real</label>
            {form.isClone && (
              <div className="rounded-lg border border-[var(--color-accent)]/50 p-3 flex flex-col gap-2">
                <p className="text-[12px] text-[var(--color-muted)]">A clonagem é feita no console do provedor, conforme as regras dele. Aqui registramos a autorização do titular (obrigatória).</p>
                <Field label="Nome do titular da voz" htmlFor="cs"><Input id="cs" value={form.speakerName} onChange={(e) => setForm({ ...form, speakerName: e.target.value })} /></Field>
                <Field label="Autorizado por" htmlFor="cg"><Input id="cg" value={form.grantedBy} onChange={(e) => setForm({ ...form, grantedBy: e.target.value })} /></Field>
                <Field label="Termo de autorização" htmlFor="ct"><TextArea id="ct" value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} placeholder="Eu, ..., autorizo o uso da minha voz para..." /></Field>
              </div>
            )}
            <Button variant="primary" disabled={!form.name || !form.voiceId || (form.isClone && (form.statement.length < 20 || !form.speakerName || !form.grantedBy))} onClick={save}>Salvar voz</Button>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="font-semibold">Vozes salvas</h2>
            {profiles.length === 0 && <p className="text-sm text-[var(--color-muted)]">Nenhuma ainda.</p>}
            {profiles.map((p) => (
              <div key={p.id} className="rounded-lg border border-[var(--color-border)] p-3 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{p.name} {p.isClone && <Badge tone="warn">Clonada · autorização registrada</Badge>}</div>
                  <div className="text-[12px] text-[var(--color-muted)]">{p.provider} · {p.providerVoiceId} · {p.settings.speed ?? 1}× · {Object.keys(p.settings.pronunciation ?? {}).length} regra(s) de pronúncia</div>
                </div>
                <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} aria-label={`Excluir ${p.name}`} onClick={async () => { await api(`/voice-profiles/${p.id}`, { method: 'DELETE' }); void loadProfiles() }}>Excluir</Button>
              </div>
            ))}
            <p className="text-[12px] text-[var(--color-muted)]">O custo de cada geração é estimado e confirmado por você antes de executar (veja Integrações).</p>
          </section>
        </div>
      )}
    </div>
  )
}
