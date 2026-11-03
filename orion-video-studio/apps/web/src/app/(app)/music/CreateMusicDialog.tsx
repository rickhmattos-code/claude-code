'use client'
import { Badge, Button, Dialog, Field, Input, Select, TextArea, useToast } from '@orion/ui'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useGeneration } from '@/components/editor/useGeneration'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import type { ProvidersDto } from '@/lib/types'

interface Section {
  name: string
  durationSeconds: number
  lyrics: string
}

/**
 * Piloto do canal: uma vogal por vez, palavra-âncora com o som inicial claro,
 * formato da boca (consciência articulatória) e pausa instrumental para a
 * criança repetir. Letra original para revisão humana antes de gerar.
 */
export const VOGAIS_PRESET: { title: string; styles: string; mood: string; sections: Section[] } = {
  title: 'A Canção das Vogais',
  styles: "cheerful children's song, ukulele and xylophone, clear warm female singer, slow clear diction, Brazilian Portuguese, 110 bpm",
  mood: 'alegre',
  sections: [
    { name: 'Abertura', durationSeconds: 6, lyrics: '' },
    { name: 'Chamada', durationSeconds: 10, lyrics: 'Oi, amiguinho, vem cantar!\nAs vogais vão começar!' },
    { name: 'Refrão', durationSeconds: 14, lyrics: 'A, E, I, O, U,\ncinco amigas pra aprender!\nA, E, I, O, U,\ncanta junto, é sua vez!' },
    { name: 'Vogal A', durationSeconds: 10, lyrics: 'A de abelha: A, A, A!\nBoca bem aberta: aaa!' },
    { name: 'Sua vez A', durationSeconds: 4, lyrics: '' },
    { name: 'Vogal E', durationSeconds: 10, lyrics: 'E de elefante: E, E, E!\nUm sorriso grande: eee!' },
    { name: 'Sua vez E', durationSeconds: 4, lyrics: '' },
    { name: 'Vogal I', durationSeconds: 10, lyrics: 'I de ilha: I, I, I!\nBoca esticadinha: iii!' },
    { name: 'Sua vez I', durationSeconds: 4, lyrics: '' },
    { name: 'Vogal O', durationSeconds: 10, lyrics: 'O de ovo: O, O, O!\nBoca redondinha: ooo!' },
    { name: 'Sua vez O', durationSeconds: 4, lyrics: '' },
    { name: 'Vogal U', durationSeconds: 10, lyrics: 'U de uva: U, U, U!\nFaz biquinho: uuu!' },
    { name: 'Sua vez U', durationSeconds: 4, lyrics: '' },
    { name: 'Refrão final', durationSeconds: 14, lyrics: 'A, E, I, O, U,\ncinco amigas pra aprender!\nA, E, I, O, U,\nagora você já sabe ler!' },
    { name: 'Despedida', durationSeconds: 8, lyrics: 'Muito bem, você cantou!\nTchau, tchau, até a próxima!' },
  ],
}

export function CreateMusicDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const ws = useSession((s) => s.workspace)!
  const toast = useToast()
  const { run, dialog, busy } = useGeneration(ws.id)
  const [providers, setProviders] = useState<ProvidersDto | null>(null)
  const [provider, setProvider] = useState('')
  const [title, setTitle] = useState('')
  const [styles, setStyles] = useState("cheerful children's song, ukulele and xylophone, clear warm female singer, slow clear diction, Brazilian Portuguese")
  const [mood, setMood] = useState('alegre')
  const [sections, setSections] = useState<Section[]>([{ name: 'Refrão', durationSeconds: 15, lyrics: '' }])
  const [reviewed, setReviewed] = useState(false)
  const [commercial, setCommercial] = useState(false)
  useEffect(() => {
    if (!open) return
    api<ProvidersDto>('/providers')
      .then((p) => {
        setProviders(p)
        setProvider((cur) => cur || p.music.find((m) => m.configured)?.id || '')
      })
      .catch(() => undefined)
  }, [open])
  const adapter = providers?.music.find((m) => m.id === provider)
  const model = adapter?.models[0]
  const total = sections.reduce((t, s) => t + s.durationSeconds, 0)
  const tooLong = model ? total > model.maxSeconds : false

  function usePreset() {
    setTitle(VOGAIS_PRESET.title)
    setStyles(VOGAIS_PRESET.styles)
    setMood(VOGAIS_PRESET.mood)
    setSections(VOGAIS_PRESET.sections.map((s) => ({ ...s })))
    setReviewed(false)
  }
  const patch = (i: number, p: Partial<Section>) => setSections(sections.map((s, j) => (j === i ? { ...s, ...p } : s)))

  async function generate() {
    if (!adapter || !model) return
    const [g] = await run(
      [
        {
          kind: 'MUSIC',
          provider: adapter.id,
          model: model.id,
          title: title.trim() || 'Música sem título',
          styles: styles.split(',').map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 8),
          sections: sections.map((s) => ({ name: s.name.trim() || 'Seção', durationSeconds: s.durationSeconds, lines: s.lyrics.split('\n').map((l) => l.trim()).filter(Boolean) })),
          mood,
          commercialPlanDeclared: commercial,
        },
      ],
      `Gerar “${title || 'música'}” (${total} s) com ${adapter.label}${adapter.mode === 'mock' ? ' (MODO DE TESTE)' : ''}.`,
    )
    if (!g) return
    if (g.status !== 'succeeded') return toast(g.error ?? 'A geração da música falhou.', 'danger')
    toast('Música criada e adicionada à biblioteca, com o registro de origem.', 'ok')
    onDone()
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Criar música com IA"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!adapter?.configured || !reviewed || tooLong || !sections.some((s) => s.lyrics.trim())} onClick={generate}>
            Gerar música
          </Button>
        </>
      }
    >
      {dialog}
      <div className="flex flex-col gap-3 text-sm">
        {!providers ? null : !adapter ? (
          <p className="text-[12px] text-[var(--color-muted)]">
            <Badge tone="warn">Configuração pendente</Badge> Defina ELEVENLABS_API_KEY no servidor para gerar músicas cantadas.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Provedor" htmlFor="mp">
              <Select id="mp" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {providers.music
                  .filter((m) => m.configured)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.mode === 'mock' ? ' (MODO DE TESTE: sem voz)' : ''}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button size="sm" onClick={usePreset}>
                Usar piloto: A Canção das Vogais
              </Button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Título" htmlFor="mct">
            <Input id="mct" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Clima" htmlFor="mcm">
            <Input id="mcm" value={mood} onChange={(e) => setMood(e.target.value)} />
          </Field>
        </div>
        <Field label="Estilo musical (separado por vírgula)" htmlFor="mcs" hint="O fornecedor recomenda estilos em inglês. Nunca cite artistas, músicas ou letras de terceiros.">
          <Input id="mcs" value={styles} onChange={(e) => setStyles(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2" aria-label="Seções da música">
          {sections.map((s, i) => (
            <div key={i} className="rounded-lg border border-[var(--color-border)] p-2 grid grid-cols-[1fr_90px_auto] gap-2 items-start">
              <Input aria-label={`Nome da seção ${i + 1}`} value={s.name} onChange={(e) => patch(i, { name: e.target.value })} />
              <Input aria-label={`Duração da seção ${i + 1} (s)`} type="number" min={3} max={120} value={s.durationSeconds} onChange={(e) => patch(i, { durationSeconds: Math.min(120, Math.max(3, Math.round(Number(e.target.value) || 3))) })} />
              <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} aria-label={`Remover seção ${i + 1}`} disabled={sections.length === 1} onClick={() => setSections(sections.filter((_, j) => j !== i))} />
              <TextArea aria-label={`Letra da seção ${i + 1}`} className="col-span-3 min-h-[52px]" placeholder="Uma linha por verso. Vazio = trecho instrumental (ex.: pausa para a criança repetir)." value={s.lyrics} onChange={(e) => patch(i, { lyrics: e.target.value })} />
            </div>
          ))}
          <Button size="sm" icon={<Plus size={14} />} disabled={sections.length >= 20} onClick={() => setSections([...sections, { name: `Seção ${sections.length + 1}`, durationSeconds: 10, lyrics: '' }])}>
            Adicionar seção
          </Button>
        </div>
        <p className={`text-[12px] ${tooLong ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted)]'}`}>
          Duração total: {total} s{model ? ` (máximo ${model.maxSeconds} s neste modelo)` : ''}.
        </p>
        <label className="flex gap-2 items-start rounded-lg border border-[var(--color-accent)]/40 p-2">
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} className="mt-1" />
          Revisei a letra: é original, adequada para crianças e sem nomes, marcas ou trechos de obras de terceiros.
        </label>
        <label className="flex gap-2 items-start">
          <input type="checkbox" checked={commercial} onChange={(e) => setCommercial(e.target.checked)} className="mt-1" />
          Declaro que meu plano no provedor permite uso comercial (monetização no YouTube). Sem esta marcação, a faixa fica registrada como “sem uso comercial”.
        </label>
      </div>
    </Dialog>
  )
}
