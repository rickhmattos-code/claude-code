import { Logo } from '@orion/ui'
import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="min-h-dvh grid place-items-center p-6">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <Logo />
        <h1 className="font-display text-xl font-semibold">Página não encontrada</h1>
        <p className="text-sm text-[var(--color-muted)]">O endereço pode ter mudado ou o conteúdo foi excluído.</p>
        <Link href="/" className="text-sm text-[var(--color-blue)] underline">
          Voltar aos projetos
        </Link>
      </div>
    </main>
  )
}
