'use client'
import type { TimelineDoc } from '@orion/shared'
import { FLICKS_PER_SECOND, addMarker, deleteClips, docDuration, duplicateClip, frameDuration, splitClip } from '@orion/timeline'
import { Badge, Button, Input, Spinner, Tabs, ToolButton, useToast } from '@orion/ui'
import { ArrowLeft, AudioLines, Bookmark, Captions, Copy, Download, FileText, Film, History, LayoutTemplate, Magnet, Mic, Palette, Redo2, Scissors, Sparkles, Trash2, Type, Undo2, Wand2 } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, errorMessage } from '@/lib/api'
import type { AssetDto } from '@/lib/types'
import { ExportDialog, VersionsDialog } from './Dialogs'
import { Inspector } from './Inspector'
import { CaptionsPanel } from './panels/CaptionsPanel'
import { MediaPanel } from './panels/MediaPanel'
import { AssistantPanel, BrandPanel, TemplatesPanel } from './panels/ProjectPanels'
import { ScenesPanel } from './panels/ScenesPanel'
import { AudioPanel, TextPanel } from './panels/TextAudioPanels'
import { TranscriptPanel } from './panels/TranscriptPanel'
import { VoicePanel } from './panels/VoicePanel'
import { Preview } from './Preview'
import { useDoc, useEditor } from './store'
import { Timeline } from './Timeline'

type Tab = 'media' | 'transcript' | 'text' | 'audio' | 'captions' | 'voice' | 'ai' | 'templates' | 'brand' | 'assistant'
type MobileView = 'panel' | 'timeline' | 'inspector'

const draftKey = (id: string) => `orion:draft:${id}`

function readDraft(id: string): { baseVersion: number; doc: TimelineDoc; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(draftKey(id))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Um único layout montado por vez (evita prévia/timeline duplicadas em segundo plano). */
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 1024px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const on = () => setDesktop(mq.matches)
    mq.addEventListener('change', on)
    on()
    return () => mq.removeEventListener('change', on)
  }, [])
  return desktop
}

export function Editor({ projectId }: { projectId: string }) {
  const toast = useToast()
  const isDesktop = useIsDesktop()
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('media')
  const [mobileView, setMobileView] = useState<MobileView>('timeline')
  const [exportOpen, setExportOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const doc = useDoc()
  const st = useEditor()
  const saving = useRef<Promise<boolean> | null>(null)

  useEffect(() => {
    useEditor.setState({ notice: toast })
  }, [toast])

  // ---------------------------------------------------------- carregamento e recuperação
  useEffect(() => {
    let alive = true
    api<{ id: string; workspaceId: string; name: string; document: TimelineDoc; docVersion: number; role: 'OWNER' | 'EDITOR' | 'VIEWER' }>(`/projects/${projectId}`)
      .then((p) => {
        if (!alive) return
        const draft = readDraft(projectId)
        let doc = p.document
        let dirty = false
        if (draft && JSON.stringify(draft.doc) !== JSON.stringify(p.document)) {
          if (draft.baseVersion === p.docVersion) {
            doc = draft.doc
            dirty = true
            toast('Alterações não salvas foram recuperadas deste navegador.', 'ok')
          } else if (confirm('Há alterações locais não salvas, mas o projeto mudou no servidor. Recuperar as alterações locais (substitui a versão do servidor)?')) {
            doc = draft.doc
            dirty = true
          } else {
            localStorage.removeItem(draftKey(projectId))
          }
        }
        st.init({ projectId, workspaceId: p.workspaceId, name: p.name, role: p.role, doc, docVersion: p.docVersion, dirty })
        setLoaded(true)
      })
      .catch((e) => setLoadError(errorMessage(e)))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // ---------------------------------------------------------- mídia do projeto (independe do painel aberto)
  useEffect(() => {
    if (!loaded) return
    let alive = true
    const load = async () => {
      const s = useEditor.getState()
      const list = await api<AssetDto[]>(`/workspaces/${s.workspaceId}/assets`)
      const referenced = new Set<string>()
      for (const t of s.history.present.tracks) for (const c of t.clips) if ('assetId' in c) referenced.add(c.assetId)
      const missing = [...referenced].filter((id) => !list.some((a) => a.id === id))
      const extra = missing.length ? await api<AssetDto[]>('/assets/batch', { body: { ids: missing } }) : []
      if (alive) s.setAssets([...list, ...extra, ...Object.values(s.assets).filter((a) => !list.some((x) => x.id === a.id) && !extra.some((x) => x.id === a.id))])
    }
    load().catch((e) => toast(errorMessage(e), 'danger'))
    // acompanha mídias em processamento
    const id = setInterval(() => {
      const pending = Object.values(useEditor.getState().assets).filter((a) => a.status === 'PROCESSING' || a.status === 'PENDING')
      if (!pending.length) return
      api<AssetDto[]>('/assets/batch', { body: { ids: pending.map((a) => a.id) } })
        .then((l) => l.forEach((a) => useEditor.getState().upsertAsset(a)))
        .catch(() => undefined)
    }, 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [loaded, toast])

  // ---------------------------------------------------------- salvamento automático
  const save = useCallback(async (): Promise<boolean> => {
    if (saving.current) await saving.current
    const s = useEditor.getState()
    if (s.saveState === 'saved') return true
    if (s.saveState === 'conflict') return false
    const docAtSave = s.history.present
    s.markSaving()
    const p = (async () => {
      try {
        const r = await api<{ docVersion: number }>(`/projects/${projectId}`, { method: 'PUT', body: { baseVersion: s.baseVersion, document: docAtSave, name: s.name } })
        useEditor.getState().markSaved(r.docVersion, docAtSave)
        if (useEditor.getState().saveState === 'saved') localStorage.removeItem(draftKey(projectId))
        return true
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) useEditor.getState().markSaveError('conflict', err.message)
        else if (err instanceof ApiError && err.status === 0) useEditor.getState().markSaveError('offline', err.message)
        else useEditor.getState().markSaveError('error', errorMessage(err))
        return false
      }
    })()
    saving.current = p
    const ok = await p
    saving.current = null
    return ok
  }, [projectId])

  useEffect(() => {
    if (!loaded) return
    if (st.saveState === 'dirty') {
      try {
        localStorage.setItem(draftKey(projectId), JSON.stringify({ baseVersion: st.baseVersion, doc, savedAt: Date.now() }))
      } catch {
        // cota do navegador: o salvamento no servidor continua
      }
      const t = setTimeout(() => void save(), 1200)
      return () => clearTimeout(t)
    }
    if (st.saveState === 'offline' || st.saveState === 'error') {
      const t = setTimeout(() => {
        useEditor.setState({ saveState: 'dirty' })
      }, 5000)
      return () => clearTimeout(t)
    }
  }, [doc, st.saveState, st.name, loaded, projectId, save, st.baseVersion])

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState().saveState
      if (s !== 'saved') e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  // ---------------------------------------------------------- atalhos
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable="true"], dialog')) return
      const s = useEditor.getState()
      const d = s.history.present
      const fd = frameDuration(d.settings.fps)
      const mod = e.ctrlKey || e.metaKey
      if (e.code === 'Space') {
        e.preventDefault()
        s.setPlaying(!s.playing)
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? s.redo() : s.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        if (s.selection[0]) s.apply((x) => duplicateClip(x, s.selection[0]!).doc)
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      } else if (e.key.toLowerCase() === 's' && !mod) {
        for (const id of s.selection) s.apply((x) => splitClip(x, id, s.playhead))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selection.length) s.apply((x) => deleteClips(x, s.selection, e.shiftKey))
        s.select([])
      } else if (e.key.toLowerCase() === 'm' && !mod) {
        s.apply((x) => addMarker(x, s.playhead))
      } else if (e.key === 'ArrowRight') {
        s.setPlayhead(s.playhead + (e.shiftKey ? FLICKS_PER_SECOND : fd))
      } else if (e.key === 'ArrowLeft') {
        s.setPlayhead(s.playhead - (e.shiftKey ? FLICKS_PER_SECOND : fd))
      } else if (e.key === 'Home') {
        s.setPlayhead(0)
      } else if (e.key === 'End') {
        s.setPlayhead(docDuration(d))
      } else if (e.key === '+' || e.key === '=') {
        s.setZoom(s.pxPerSec * 1.25)
      } else if (e.key === '-') {
        s.setZoom(s.pxPerSec / 1.25)
      } else if (e.key === 'Escape') {
        s.select([])
        s.selectTrack(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  if (loadError) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[var(--color-danger)]">{loadError}</p>
        <Link href="/">
          <Button>Voltar aos projetos</Button>
        </Link>
      </div>
    )
  }
  if (!loaded || !doc.settings) {
    return (
      <div className="min-h-dvh flex items-center justify-center gap-2 text-[var(--color-muted)]">
        <Spinner /> Abrindo projeto…
      </div>
    )
  }

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'media', label: 'Mídia', icon: <Film size={14} /> },
    { id: 'transcript', label: 'Transcrição', icon: <FileText size={14} /> },
    { id: 'text', label: 'Texto', icon: <Type size={14} /> },
    { id: 'audio', label: 'Música', icon: <AudioLines size={14} /> },
    { id: 'captions', label: 'Legendas', icon: <Captions size={14} /> },
    { id: 'voice', label: 'Voz', icon: <Mic size={14} /> },
    { id: 'ai', label: 'Cenas IA', icon: <Wand2 size={14} /> },
    { id: 'templates', label: 'Modelos', icon: <LayoutTemplate size={14} /> },
    { id: 'brand', label: 'Marca', icon: <Palette size={14} /> },
    { id: 'assistant', label: 'Assistente', icon: <Sparkles size={14} /> },
  ]
  const panel = {
    media: <MediaPanel />,
    transcript: <TranscriptPanel />,
    text: <TextPanel />,
    audio: <AudioPanel />,
    captions: <CaptionsPanel />,
    voice: <VoicePanel />,
    ai: <ScenesPanel />,
    templates: <TemplatesPanel />,
    brand: <BrandPanel />,
    assistant: <AssistantPanel onOpenTab={setTab} />,
  }[tab]

  const saveLabel = { saved: 'Salvo', dirty: 'Alterações não salvas', saving: 'Salvando…', conflict: 'Conflito de versão', error: 'Erro ao salvar', offline: 'Sem conexão — guardado no navegador' }[st.saveState]
  const saveTone = st.saveState === 'saved' ? 'ok' : st.saveState === 'conflict' || st.saveState === 'error' ? 'danger' : st.saveState === 'offline' ? 'warn' : 'neutral'
  const sel = st.selection

  const toolbar = (
    <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
      <ToolButton label="Desfazer" shortcut="Ctrl+Z" icon={<Undo2 size={16} />} disabled={!st.history.past.length} onClick={st.undo} />
      <ToolButton label="Refazer" shortcut="Ctrl+Shift+Z" icon={<Redo2 size={16} />} disabled={!st.history.future.length} onClick={st.redo} />
      <ToolButton label="Dividir" shortcut="S" icon={<Scissors size={16} />} disabled={!sel.length} onClick={() => sel.forEach((id) => st.apply((x) => splitClip(x, id, st.playhead)))} />
      <ToolButton label="Duplicar" shortcut="Ctrl+D" icon={<Copy size={16} />} disabled={sel.length !== 1} onClick={() => st.apply((x) => duplicateClip(x, sel[0]!).doc)} />
      <ToolButton label="Excluir" shortcut="Del" icon={<Trash2 size={16} />} disabled={!sel.length} onClick={() => { st.apply((x) => deleteClips(x, sel, false)); st.select([]) }} />
      <ToolButton label="Fechar espaço" shortcut="Shift+Del" icon={<Trash2 size={16} className="text-[var(--color-accent)]" />} disabled={!sel.length} onClick={() => { st.apply((x) => deleteClips(x, sel, true)); st.select([]) }} />
      <ToolButton label="Ímã" icon={<Magnet size={16} />} active={st.snap} onClick={st.toggleSnap} />
      <ToolButton label="Marcador" shortcut="M" icon={<Bookmark size={16} />} onClick={() => st.apply((x) => addMarker(x, st.playhead))} />
    </div>
  )

  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      <header className="flex items-center gap-2 px-2 h-14 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
        <Link href="/" aria-label="Voltar aos projetos" className="p-2 rounded hover:bg-[var(--color-surface-2)]">
          <ArrowLeft size={18} />
        </Link>
        <Input aria-label="Nome do projeto" className="max-w-[220px] h-8 bg-transparent border-transparent hover:border-[var(--color-border)]" value={st.name} onChange={(e) => st.setName(e.target.value.slice(0, 120))} />
        <span title={st.saveError ?? undefined} aria-live="polite">
          <Badge tone={saveTone}>{saveLabel}</Badge>
        </span>
        {st.saveState === 'conflict' && (
          <Button size="sm" variant="danger" onClick={() => location.reload()}>
            Recarregar versão do servidor
          </Button>
        )}
        {st.role === 'VIEWER' && <Badge tone="warn">Somente leitura</Badge>}
        {isDesktop && <div className="mx-auto">{toolbar}</div>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" icon={<History size={14} />} onClick={() => setVersionsOpen(true)}>
            <span className="hidden sm:inline">Versões</span>
          </Button>
          <Button size="sm" variant="primary" icon={<Download size={14} />} onClick={() => setExportOpen(true)}>
            Exportar
          </Button>
        </div>
      </header>

      {/* desktop: painel | prévia | inspetor ; timeline embaixo */}
      {isDesktop ? (
      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: '340px 1fr 310px', gridTemplateRows: 'minmax(0,1fr) minmax(220px, 38vh)' }}>
        <aside className="row-span-1 border-r border-[var(--color-border)] flex flex-col min-h-0 bg-[var(--color-surface)]">
          <div className="px-2 pt-2">
            <Tabs tabs={tabs} value={tab} onChange={setTab} label="Painéis" />
          </div>
          <div className="flex-1 overflow-auto">{panel}</div>
        </aside>
        <div className="min-h-0 min-w-0 bg-[var(--color-bg)]">
          <Preview />
        </div>
        <aside className="border-l border-[var(--color-border)] overflow-auto bg-[var(--color-surface)]" aria-label="Propriedades">
          <h2 className="px-4 pt-3 font-display font-semibold">Propriedades</h2>
          <Inspector />
        </aside>
        <div className="col-span-3 min-h-0">
          <Timeline />
        </div>
      </div>

      ) : (
      /* celular e tablet: prévia em cima, uma área inferior por vez */
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="h-[38vh] min-h-[200px] bg-[var(--color-bg)] shrink-0">
          <Preview />
        </div>
        <div className="border-y border-[var(--color-border)] bg-[var(--color-surface)] px-1">{toolbar}</div>
        <div className="flex-1 min-h-0 overflow-auto">
          {mobileView === 'timeline' && <Timeline />}
          {mobileView === 'inspector' && <Inspector />}
          {mobileView === 'panel' && (
            <div className="flex flex-col h-full">
              <div className="px-2 pt-2">
                <Tabs tabs={tabs} value={tab} onChange={setTab} label="Painéis" />
              </div>
              <div className="flex-1 overflow-auto">{panel}</div>
            </div>
          )}
        </div>
        <nav aria-label="Áreas do editor" className="grid grid-cols-3 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          {([['panel', 'Recursos'], ['timeline', 'Linha do tempo'], ['inspector', 'Propriedades']] as const).map(([v, label]) => (
            <button key={v} aria-pressed={mobileView === v} onClick={() => setMobileView(v)} className={`h-12 text-[13px] ${mobileView === v ? 'text-[var(--color-accent)] font-medium' : 'text-[var(--color-muted)]'}`}>
              {label}
            </button>
          ))}
        </nav>
      </div>
      )}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} flush={save} />
      <VersionsDialog open={versionsOpen} onClose={() => setVersionsOpen(false)} flush={save} />
    </div>
  )
}
