'use client'
import { Button, Logo, Select, Spinner } from '@orion/ui'
import { Clapperboard, FolderOpen, History, LayoutTemplate, LogOut, Mic, Music, Palette, PlugZap, Sparkles, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { api } from '@/lib/api'
import { useSession, useT } from '@/lib/session'

export function AppShell({ children, bare }: { children: React.ReactNode; bare?: boolean }) {
  const t = useT()
  const router = useRouter()
  const pathname = usePathname()
  const { me, loading, load, workspace, setWorkspace } = useSession()
  useEffect(() => {
    load()
      .then((m) => {
        if (!m.user) router.replace('/login')
      })
      .catch(() => router.replace('/login'))
  }, [load, router])
  if (loading || !me?.user || !workspace) {
    return (
      <div className="min-h-dvh flex items-center justify-center text-[var(--color-muted)] gap-2">
        <Spinner /> {t('common.loading')}
      </div>
    )
  }
  if (bare) return <>{children}</>
  const nav = [
    { href: '/', label: t('nav.projects'), icon: <FolderOpen size={18} /> },
    { href: '/templates', label: t('nav.templates'), icon: <LayoutTemplate size={18} /> },
    { href: '/assistant', label: t('nav.assistant'), icon: <Sparkles size={18} /> },
    { href: '/music', label: t('nav.music'), icon: <Music size={18} /> },
    { href: '/voices', label: t('nav.voices'), icon: <Mic size={18} /> },
    { href: '/characters', label: t('nav.characters'), icon: <Users size={18} /> },
    { href: '/brand', label: t('nav.brand'), icon: <Palette size={18} /> },
    { href: '/history', label: t('nav.history'), icon: <History size={18} /> },
    { href: '/providers', label: t('nav.providers'), icon: <PlugZap size={18} /> },
  ]
  return (
    <div className="min-h-dvh flex flex-col lg:flex-row">
      <aside className="lg:w-60 lg:min-h-dvh border-b lg:border-b-0 lg:border-r border-[var(--color-border)] bg-[var(--color-surface)] flex lg:flex-col">
        <div className="px-4 py-3 lg:py-5 flex items-center">
          <Link href="/" aria-label="Início">
            <Logo />
          </Link>
        </div>
        <nav aria-label="Principal" className="flex lg:flex-col gap-0.5 px-2 overflow-x-auto no-scrollbar flex-1">
          {nav.map((n) => {
            const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href)
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-md px-3 h-10 text-sm whitespace-nowrap ${active ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] font-medium' : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'}`}
              >
                {n.icon}
                {n.label}
              </Link>
            )
          })}
        </nav>
        <div className="hidden lg:flex flex-col gap-2 p-3 border-t border-[var(--color-border)]">
          {me.workspaces.length > 1 && (
            <Select aria-label="Workspace" value={workspace.id} onChange={(e) => setWorkspace(me.workspaces.find((w) => w.id === e.target.value)!)}>
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          <div className="text-[12px] text-[var(--color-muted)] truncate" title={me.user.email}>
            <Clapperboard size={12} className="inline mr-1" />
            {workspace.name}
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<LogOut size={14} />}
            onClick={async () => {
              await api('/auth/logout', { body: {} })
              router.replace('/login')
            }}
          >
            {t('nav.logout')}
          </Button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 px-4 py-5 lg:px-8 lg:py-8">{children}</main>
    </div>
  )
}
