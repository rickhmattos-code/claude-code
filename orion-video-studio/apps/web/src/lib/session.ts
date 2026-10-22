'use client'
import { translate, type MessageKey } from '@orion/shared'
import { create } from 'zustand'
import { api } from './api'
import type { Me, Workspace } from './types'

interface SessionState {
  me: Me | null
  loading: boolean
  workspace: Workspace | null
  locale: string
  load: () => Promise<Me>
  setWorkspace: (w: Workspace) => void
}

export const useSession = create<SessionState>((set, get) => ({
  me: null,
  loading: true,
  workspace: null,
  locale: 'pt-BR',
  async load() {
    const me = await api<Me>('/auth/me')
    let saved: string | null = null
    try {
      saved = localStorage.getItem('orion:workspace')
    } catch {
      saved = null
    }
    const ws = me.workspaces.find((w) => w.id === saved) ?? me.workspaces[0] ?? null
    set({ me, loading: false, workspace: get().workspace ?? ws })
    return me
  },
  setWorkspace(w) {
    try {
      localStorage.setItem('orion:workspace', w.id)
    } catch {
      // armazenamento indisponível: apenas não persiste a escolha
    }
    set({ workspace: w })
  },
}))

export function useT() {
  const locale = useSession((s) => s.locale)
  return (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars)
}
