import type { Metadata, Viewport } from 'next'
import { ToastProvider } from '@orion/ui'
import './globals.css'

export const metadata: Metadata = {
  title: 'Orion Video Studio',
  description: 'Edição de vídeo com linha do tempo, modelos, narração, legendas e cenas por IA.',
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0e0f12' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
