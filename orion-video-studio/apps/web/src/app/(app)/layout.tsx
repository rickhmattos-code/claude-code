'use client'
import { usePathname } from 'next/navigation'
import { AppShell } from '@/components/AppShell'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  // o editor ocupa a tela inteira
  return <AppShell bare={pathname.startsWith('/projects/')}>{children}</AppShell>
}
