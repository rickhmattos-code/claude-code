'use client'
import { Button, Field, Input, Logo } from '@orion/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useT } from '@/lib/session'

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const t = useT()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api(`/auth/${mode}`, { body: mode === 'login' ? { email, password } : { email, password, name } })
      router.push('/')
      router.refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="min-h-dvh flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
        <Logo size={32} />
        <h1 className="font-display text-xl font-semibold">{mode === 'login' ? t('auth.login') : t('auth.register')}</h1>
        {mode === 'register' && (
          <Field label={t('auth.name')} htmlFor="name">
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
        )}
        <Field label={t('auth.email')} htmlFor="email">
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
        <Field label={t('auth.password')} htmlFor="password" hint={mode === 'register' ? t('auth.passwordHint') : undefined}>
          <Input id="password" type="password" required minLength={mode === 'register' ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          {mode === 'login' ? t('auth.login') : t('auth.register')}
        </Button>
        <p className="text-sm text-[var(--color-muted)]">
          {mode === 'login' ? (
            <>
              {t('auth.noAccount')}{' '}
              <Link className="text-[var(--color-blue)] underline" href="/register">
                {t('auth.register')}
              </Link>
            </>
          ) : (
            <>
              {t('auth.hasAccount')}{' '}
              <Link className="text-[var(--color-blue)] underline" href="/login">
                {t('auth.login')}
              </Link>
            </>
          )}
        </p>
      </form>
    </main>
  )
}
