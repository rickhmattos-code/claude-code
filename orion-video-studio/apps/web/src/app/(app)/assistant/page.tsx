'use client'
import type { AspectPreset, AssistantBrief, Scene, TimelineDoc } from '@orion/shared'
import { FLICKS_PER_SECOND, addClip, assembleScenes, createDocument, docDuration, executeCommand, makeTextClip, quantize, scriptToScenes, secondsToFlicks } from '@orion/timeline'
import { Badge, Button, Field, Input, Select, TextArea, useToast } from '@orion/ui'
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { MusicDto } from '@/lib/types'

interface Plan {
  source: 'llm' | 'local'
  openings: string[]
  script: string
  scenes: Scene[]
  musicSuggestions: Array<{ mood: string; reason: string }>
  cta: string
  estimatedSeconds: number
  notes: string[]
}

export default function AssistantPage() {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const router = useRouter()
  const [step, setStep] = useState<1 | 2>(1)
  const [busy, setBusy] = useState(false)
  const [brief, setBrief] = useState<AssistantBrief>({ theme: '', audience: '', goal: '', durationSeconds: 90, aspect: '9:16', tone: 'reflexivo', visualStyle: 'Fotografia cinematográfica, luz quente, contraste suave', voice: '', references: '', script: '' })
  const [plan, setPlan] = useState<Plan | null>(null)
  const [opening, setOpening] = useState(0)
  const [music, setMusic] = useState<MusicDto[]>([])
  const [musicId, setMusicId] = useState('')
  const set = <K extends keyof AssistantBrief>(k: K, v: AssistantBrief[K]) => setBrief({ ...brief, [k]: v })

  async function generatePlan() {
    setBusy(true)
    try {
      const p = await api<Plan>(`/workspaces/${ws.id}/assistant/plan`, { body: { brief: { ...brief, script: brief.script || undefined, voice: brief.voice || undefined, references: brief.references || undefined }, maxSceneSeconds: 8 } })
      setPlan(p)
      setOpening(0)
      const all = await api<MusicDto[]>(`/workspaces/${ws.id}/music?sfx=false`)
      const moods = p.musicSuggestions.map((m) => m.mood)
      const sorted = [...all].sort((a, b) => Number(moods.includes(b.mood)) - Number(moods.includes(a.mood)))
      setMusic(sorted)
      setMusicId(sorted[0]?.id ?? '')
      setStep(2)
    } catch (err) {
      toast(errorMessage(err), 'danger')
    } finally {
      setBusy(false)
    }
  }

  function reorganize(script: string) {
    if (!plan) return
    setPlan({ ...plan, script, scenes: scriptToScenes(script, { maxSceneSeconds: 8, visualStyle: brief.visualStyle }) })
  }

  async function createProject() {
    if (!plan) return
    setBusy(true)
    try {
      let doc: TimelineDoc = createDocument({ aspect: brief.aspect as AspectPreset })
      doc = assembleScenes(doc, plan.scenes, [])
      const fps = doc.settings.fps
      const text = doc.tracks.find((t) => t.kind === 'text')!
      const open = makeTextClip(plan.openings[opening] ?? plan.openings[0]!, 0, quantize(secondsToFlicks(3.5), fps))
      if (open.type === 'text') open.animation = 'pop'
      open.name = 'Abertura'
      doc = addClip(doc, text.id, open)
      const total = docDuration(doc)
      const ctaDur = quantize(secondsToFlicks(3), fps)
      if (plan.cta && total > ctaDur) {
        const cta = makeTextClip(plan.cta, total - ctaDur, ctaDur)
        if (cta.type === 'text') {
          cta.style = { ...cta.style, fontSize: 64, background: '#000000' }
          cta.transform = { ...cta.transform, y: 0.78 }
          cta.animation = 'slide-up'
        }
        cta.name = 'Chamada para ação'
        doc = addClip(doc, text.id, cta)
      }
      const m = music.find((x) => x.id === musicId)
      if (m) doc = executeCommand(doc, { type: 'replaceMusic', musicTrackId: m.id, assetId: m.assetId, durationFlicks: m.durationFlicks, title: m.title })
      doc = { ...doc, scenes: doc.scenes.map((s) => ({ ...s })) }
      const created = await api<{ id: string; docVersion: number }>(`/workspaces/${ws.id}/projects`, { body: { name: brief.theme.slice(0, 100) || 'Projeto do assistente', aspect: brief.aspect } })
      await api(`/projects/${created.id}`, { method: 'PUT', body: { baseVersion: created.docVersion ?? 1, document: doc } })
      toast('Projeto criado. Nenhuma operação paga foi iniciada: gere narração e cenas nos painéis Voz e Cenas IA.', 'ok')
      router.push(`/projects/${created.id}`)
    } catch (err) {
      toast(errorMessage(err), 'danger')
      setBusy(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-5">
      <header>
        <h1 className="font-display text-2xl font-bold flex items-center gap-2">
          <Sparkles className="text-[var(--color-accent)]" /> Assistente de criação
        </h1>
        <p className="text-sm text-[var(--color-muted)]">Ideia ou roteiro → aberturas, roteiro, storyboard, trilha e chamada para ação para revisão. Nada pago é executado sem sua aprovação.</p>
      </header>
      <ol className="flex gap-2 text-[13px]" aria-label="Etapas">
        <li>
          <Badge tone={step === 1 ? 'accent' : 'neutral'}>1. Briefing</Badge>
        </li>
        <li>
          <Badge tone={step === 2 ? 'accent' : 'neutral'}>2. Revisão</Badge>
        </li>
      </ol>
      {step === 1 && (
        <form
          className="grid md:grid-cols-2 gap-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5"
          onSubmit={(e) => {
            e.preventDefault()
            void generatePlan()
          }}
        >
          <div className="md:col-span-2">
            <Field label="Tema" htmlFor="th">
              <Input id="th" required minLength={3} value={brief.theme} onChange={(e) => set('theme', e.target.value)} placeholder="Ex.: Disciplina diária para vendedores" />
            </Field>
          </div>
          <Field label="Público" htmlFor="au">
            <Input id="au" value={brief.audience} onChange={(e) => set('audience', e.target.value)} placeholder="Ex.: vendedores autônomos" />
          </Field>
          <Field label="Objetivo" htmlFor="go">
            <Input id="go" value={brief.goal} onChange={(e) => set('goal', e.target.value)} placeholder="Ex.: seguir o perfil" />
          </Field>
          <Field label="Duração (segundos)" htmlFor="du" hint="15 s a 30 min. Acima de 60 s as cenas são divididas e montadas automaticamente.">
            <Input id="du" type="number" min={15} max={1800} value={brief.durationSeconds} onChange={(e) => set('durationSeconds', Number(e.target.value))} />
          </Field>
          <Field label="Formato" htmlFor="fm">
            <Select id="fm" value={brief.aspect} onChange={(e) => set('aspect', e.target.value as AspectPreset)}>
              <option value="9:16">9:16 Vertical</option>
              <option value="16:9">16:9 Horizontal</option>
              <option value="1:1">1:1 Quadrado</option>
              <option value="4:5">4:5 Retrato</option>
            </Select>
          </Field>
          <Field label="Tom" htmlFor="to">
            <Select id="to" value={brief.tone} onChange={(e) => set('tone', e.target.value)}>
              {['reflexivo', 'energético', 'institucional', 'educativo e leve', 'histórico e dramático', 'bem-humorado', 'vendas e urgência'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Estilo visual" htmlFor="vs">
            <Input id="vs" value={brief.visualStyle} onChange={(e) => set('visualStyle', e.target.value)} />
          </Field>
          <Field label="Voz desejada (opcional)" htmlFor="vo">
            <Input id="vo" value={brief.voice} onChange={(e) => set('voice', e.target.value)} placeholder="Ex.: masculina grave, calma" />
          </Field>
          <Field label="Referências (opcional)" htmlFor="rf">
            <Input id="rf" value={brief.references} onChange={(e) => set('references', e.target.value)} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Roteiro próprio (opcional)" htmlFor="sc" hint="Se informado, será dividido em cenas sem alterar o texto. Separe cenas por linha em branco.">
              <TextArea id="sc" className="min-h-[160px]" value={brief.script} onChange={(e) => set('script', e.target.value)} />
            </Field>
          </div>
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" variant="primary" loading={busy} icon={<ArrowRight size={16} />}>
              Gerar plano para revisão
            </Button>
          </div>
        </form>
      )}
      {step === 2 && plan && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2 items-center">
            <Badge tone={plan.source === 'llm' ? 'info' : 'warn'}>{plan.source === 'llm' ? 'Gerado por IA (Anthropic)' : 'Organizador local (sem IA)'}</Badge>
            <span className="text-[13px] text-[var(--color-muted)]">
              {plan.scenes.length} cenas · narração estimada ~{Math.round(plan.scenes.reduce((a, s) => a + s.estimatedDuration, 0) / FLICKS_PER_SECOND)} s (meta {brief.durationSeconds} s)
            </span>
          </div>
          {plan.notes.map((n) => (
            <p key={n} className="text-[13px] text-[var(--color-muted)] border-l-2 border-[var(--color-accent)] pl-3">
              {n}
            </p>
          ))}
          <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 flex flex-col gap-2">
            <h2 className="font-semibold">Abertura (escolha 1 de 3)</h2>
            {plan.openings.map((o, i) => (
              <label key={i} className={`flex gap-2 items-start rounded-lg border p-3 cursor-pointer ${opening === i ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
                <input type="radio" name="opening" checked={opening === i} onChange={() => setOpening(i)} className="mt-1" />
                <Input aria-label={`Abertura ${i + 1}`} value={o} onChange={(e) => setPlan({ ...plan, openings: plan.openings.map((x, j) => (j === i ? e.target.value : x)) })} />
              </label>
            ))}
          </section>
          <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 flex flex-col gap-2">
            <h2 className="font-semibold">Roteiro e narração</h2>
            <TextArea aria-label="Roteiro" className="min-h-[200px]" value={plan.script} onChange={(e) => setPlan({ ...plan, script: e.target.value })} />
            <Button size="sm" onClick={() => reorganize(plan.script)}>
              Reorganizar cenas a partir do roteiro
            </Button>
          </section>
          <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 flex flex-col gap-2">
            <h2 className="font-semibold">Storyboard ({plan.scenes.length} cenas)</h2>
            <ol className="flex flex-col gap-2">
              {plan.scenes.map((s, i) => (
                <li key={s.key} className="rounded-lg border border-[var(--color-border)] p-3 grid md:grid-cols-2 gap-2">
                  <div className="md:col-span-2 flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
                    <span className="tabular-nums">Cena {i + 1}</span>
                    <span>~{(s.estimatedDuration / FLICKS_PER_SECOND).toFixed(1).replace('.', ',')} s</span>
                  </div>
                  <Field label="Narração" htmlFor={`n-${s.key}`}>
                    <TextArea id={`n-${s.key}`} className="min-h-[60px]" value={s.narration} onChange={(e) => setPlan({ ...plan, scenes: plan.scenes.map((x) => (x.key === s.key ? { ...x, narration: e.target.value } : x)) })} />
                  </Field>
                  <Field label="Descrição visual" htmlFor={`p-${s.key}`}>
                    <TextArea id={`p-${s.key}`} className="min-h-[60px]" value={s.visualPrompt} onChange={(e) => setPlan({ ...plan, scenes: plan.scenes.map((x) => (x.key === s.key ? { ...x, visualPrompt: e.target.value } : x)) })} />
                  </Field>
                </li>
              ))}
            </ol>
          </section>
          <section className="grid md:grid-cols-2 gap-4">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 flex flex-col gap-2">
              <h2 className="font-semibold">Trilha sugerida</h2>
              <p className="text-[12px] text-[var(--color-muted)]">{plan.musicSuggestions.map((m) => `${m.mood}: ${m.reason}`).join(' ')}</p>
              <Select aria-label="Música" value={musicId} onChange={(e) => setMusicId(e.target.value)}>
                <option value="">Sem música</option>
                {music.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title} — {m.mood} ({m.license.licenseName})
                  </option>
                ))}
              </Select>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 flex flex-col gap-2">
              <h2 className="font-semibold">Chamada para ação</h2>
              <Input aria-label="Chamada para ação" value={plan.cta} onChange={(e) => setPlan({ ...plan, cta: e.target.value })} />
            </div>
          </section>
          <div className="flex justify-between">
            <Button icon={<ArrowLeft size={16} />} onClick={() => setStep(1)}>
              Voltar
            </Button>
            <Button variant="primary" loading={busy} onClick={createProject}>
              Aprovar e criar projeto
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
