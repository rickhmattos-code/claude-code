'use client'
import type { TimelineDoc } from '@orion/shared'
import { EditError, type History, createHistory, push, redo, undo } from '@orion/timeline'
import { create } from 'zustand'
import type { AssetDto } from '@/lib/types'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'offline'

interface EditorState {
  projectId: string
  workspaceId: string
  name: string
  role: 'OWNER' | 'EDITOR' | 'VIEWER'
  history: History<TimelineDoc>
  baseVersion: number
  saveState: SaveState
  saveError: string | null
  selection: string[]
  selectedTrackId: string | null
  selectedCaptionId: string | null
  playhead: number
  playing: boolean
  pxPerSec: number
  snap: boolean
  assets: Record<string, AssetDto>
  assetsLoaded: boolean
  lastCoalesce: { key: string; at: number } | null
  notice: ((msg: string, tone?: 'ok' | 'danger' | 'info') => void) | null
  init(p: { projectId: string; workspaceId: string; name: string; role: EditorState['role']; doc: TimelineDoc; docVersion: number; dirty?: boolean }): void
  /** aplica uma operação; erros de edição viram aviso (o documento não muda) */
  apply(fn: (doc: TimelineDoc) => TimelineDoc, opts?: { coalesce?: string }): boolean
  replaceDoc(doc: TimelineDoc, docVersion: number): void
  undo(): void
  redo(): void
  select(ids: string[], additive?: boolean): void
  selectTrack(id: string | null): void
  selectCaption(id: string | null): void
  setPlayhead(t: number): void
  setPlaying(p: boolean): void
  setZoom(pps: number): void
  toggleSnap(): void
  setAssets(list: AssetDto[]): void
  upsertAsset(a: AssetDto): void
  markSaving(): void
  markSaved(version: number, docAtSave: TimelineDoc): void
  markSaveError(state: SaveState, msg: string | null): void
  setName(name: string): void
}

export const useEditor = create<EditorState>((set, get) => ({
  projectId: '',
  workspaceId: '',
  name: '',
  role: 'EDITOR',
  history: createHistory({} as TimelineDoc),
  baseVersion: 1,
  saveState: 'saved',
  saveError: null,
  selection: [],
  selectedTrackId: null,
  selectedCaptionId: null,
  playhead: 0,
  playing: false,
  pxPerSec: 40,
  snap: true,
  assets: {},
  assetsLoaded: false,
  lastCoalesce: null,
  notice: null,
  init(p) {
    set({
      projectId: p.projectId,
      workspaceId: p.workspaceId,
      name: p.name,
      role: p.role,
      history: createHistory(p.doc),
      baseVersion: p.docVersion,
      saveState: p.dirty ? 'dirty' : 'saved',
      selection: [],
      playhead: 0,
      playing: false,
    })
  },
  apply(fn, opts) {
    const { history, lastCoalesce, notice, role } = get()
    if (role === 'VIEWER') {
      notice?.('Seu papel é somente leitura neste espaço de trabalho.', 'danger')
      return false
    }
    let next: TimelineDoc
    try {
      next = fn(history.present)
    } catch (err) {
      if (err instanceof EditError) {
        notice?.(err.message, 'danger')
        return false
      }
      throw err
    }
    if (next === history.present) return true
    const now = Date.now()
    const coalesce = opts?.coalesce && lastCoalesce?.key === opts.coalesce && now - lastCoalesce.at < 1500
    set({
      history: coalesce ? { ...history, present: next, future: [] } : push(history, next),
      saveState: 'dirty',
      lastCoalesce: opts?.coalesce ? { key: opts.coalesce, at: now } : null,
    })
    return true
  },
  replaceDoc(doc, docVersion) {
    set({ history: push(get().history, doc), baseVersion: docVersion, saveState: 'saved' })
  },
  undo() {
    set({ history: undo(get().history), saveState: 'dirty', lastCoalesce: null })
  },
  redo() {
    set({ history: redo(get().history), saveState: 'dirty', lastCoalesce: null })
  },
  select(ids, additive) {
    const cur = get().selection
    set({ selection: additive ? [...new Set([...cur, ...ids])] : ids, selectedCaptionId: null })
  },
  selectTrack(id) {
    set({ selectedTrackId: id })
  },
  selectCaption(id) {
    set({ selectedCaptionId: id, selection: id ? [] : get().selection })
  },
  setPlayhead(t) {
    set({ playhead: Math.max(0, Math.round(t)) })
  },
  setPlaying(p) {
    set({ playing: p })
  },
  setZoom(pps) {
    set({ pxPerSec: Math.min(400, Math.max(4, pps)) })
  },
  toggleSnap() {
    set({ snap: !get().snap })
  },
  setAssets(list) {
    set({ assets: Object.fromEntries(list.map((a) => [a.id, a])), assetsLoaded: true })
  },
  upsertAsset(a) {
    set({ assets: { ...get().assets, [a.id]: a } })
  },
  markSaving() {
    set({ saveState: 'saving' })
  },
  markSaved(version, docAtSave) {
    // se houve edição durante o salvamento, continua "sujo"
    set({ baseVersion: version, saveState: get().history.present === docAtSave ? 'saved' : 'dirty', saveError: null })
  },
  markSaveError(state, msg) {
    set({ saveState: state, saveError: msg })
  },
  setName(name) {
    set({ name, saveState: 'dirty' })
  },
}))

export const useDoc = () => useEditor((s) => s.history.present)
