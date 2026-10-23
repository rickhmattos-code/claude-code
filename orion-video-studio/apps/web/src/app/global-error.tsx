'use client'
import './globals.css'

/** Último recurso quando o próprio layout falha: precisa declarar <html> e <body>. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="pt-BR">
      <body>
        <main className="min-h-dvh grid place-items-center p-6 text-center">
          <div className="flex flex-col items-center gap-4 max-w-sm">
            <h1 className="text-xl font-semibold">Algo deu errado</h1>
            <p className="text-sm text-[var(--color-muted)]">O aplicativo encontrou um erro inesperado.</p>
            <button type="button" onClick={reset} className="rounded-md px-4 py-2 bg-[var(--color-accent)] text-[var(--color-accent-ink)] font-medium">
              Tentar novamente
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
