'use client'
import { Button, Logo } from '@orion/ui'
import Link from 'next/link'

/** Erro inesperado numa página (substitui a tela padrão do Next, em inglês). */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-dvh grid place-items-center p-6">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <Logo />
        <h1 className="font-display text-xl font-semibold">Algo deu errado</h1>
        <p className="text-sm text-[var(--color-muted)]">Ocorreu um erro inesperado ao exibir esta página. Suas alterações salvas não foram perdidas.</p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={reset}>
            Tentar novamente
          </Button>
          <Link href="/" className="inline-flex">
            <Button>Voltar aos projetos</Button>
          </Link>
        </div>
      </div>
    </main>
  )
}
