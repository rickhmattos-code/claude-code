'use client'
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

/**
 * Design system ORION — componentes acessíveis (rótulos visíveis, foco
 * visível, aria) usando tokens definidos em apps/web/src/app/globals.css.
 * Identidade: grafite quente + Âmbar Betelgeuse (#F2A93B) + Azul Rigel (#6E8BFF),
 * as duas estrelas mais brilhantes de Órion.
 */

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ')

export function Logo({ size = 28, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 select-none" aria-label="Orion Video Studio">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--color-surface-2)" />
        {/* cinturão de Órion: três estrelas em diagonal */}
        <circle cx="10" cy="20" r="2.6" fill="var(--color-blue)" />
        <circle cx="16" cy="16" r="2.6" fill="var(--color-text)" />
        <circle cx="22" cy="12" r="2.6" fill="var(--color-accent)" />
        <path d="M7 25 L25 7" stroke="var(--color-border-strong)" strokeWidth="0.8" />
      </svg>
      {withText && (
        <span className="font-display text-[15px] font-bold tracking-tight">
          Orion <span className="text-[var(--color-muted)] font-semibold">Video Studio</span>
        </span>
      )}
    </span>
  )
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:brightness-110 font-semibold',
  secondary: 'bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
  ghost: 'text-[var(--color-text)] hover:bg-[var(--color-surface-2)]',
  danger: 'bg-[var(--color-danger)]/15 text-[var(--color-danger)] border border-[var(--color-danger)]/40 hover:bg-[var(--color-danger)]/25',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  icon?: ReactNode
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-blue)] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-10 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  )
})

/** Botão de ícone SEMPRE com rótulo (visível ou tooltip + aria-label) e atalho opcional. */
export function ToolButton({ label, icon, shortcut, active, showLabel = true, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode; shortcut?: string; active?: boolean; showLabel?: boolean }) {
  return (
    <button
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      title={shortcut ? `${label} — ${shortcut}` : label}
      aria-pressed={active}
      className={cx(
        'inline-flex flex-col items-center justify-center gap-0.5 rounded-md px-2 min-w-[44px] h-11 text-[11px] leading-none transition focus-visible:outline-2 focus-visible:outline-[var(--color-blue)] disabled:opacity-40',
        active ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]' : 'text-[var(--color-text)] hover:bg-[var(--color-surface-2)]',
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true">{icon}</span>
      {showLabel && <span className="text-[var(--color-muted)]">{label}</span>}
    </button>
  )
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-[var(--color-muted)]">
        {label}
      </label>
      {children}
      {hint && !error && <span className="text-[11px] text-[var(--color-muted)]">{hint}</span>}
      {error && (
        <span role="alert" className="text-[11px] text-[var(--color-danger)]">
          {error}
        </span>
      )}
    </div>
  )
}

const inputCls =
  'h-9 w-full rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] px-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-2 focus:outline-[var(--color-blue)] focus:border-transparent'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(inputCls, rest.type === 'color' && 'p-1 cursor-pointer', className)} {...rest} />
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputCls, 'h-auto min-h-[80px] py-2 leading-relaxed', className)} {...rest} />
})

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputCls, 'pr-7', className)} {...rest}>
      {children}
    </select>
  )
}

export function Slider({ label, value, min, max, step = 0.01, onChange, format, onCommit, id }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void; format?: (v: number) => string; id?: string }) {
  const auto = useId()
  const fid = id ?? auto
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[12px]">
        <label htmlFor={fid} className="text-[var(--color-muted)]">
          {label}
        </label>
        <span className="tabular-nums text-[var(--color-text)]">{format ? format(value) : formatDecimal(value, 2)}</span>
      </div>
      <input
        id={fid}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        className="orion-range w-full"
      />
    </div>
  )
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'; children: ReactNode }) {
  const tones = {
    neutral: 'bg-[var(--color-surface-2)] text-[var(--color-muted)] border-[var(--color-border)]',
    ok: 'bg-[var(--color-ok)]/12 text-[var(--color-ok)] border-[var(--color-ok)]/30',
    warn: 'bg-[var(--color-accent)]/12 text-[var(--color-accent)] border-[var(--color-accent)]/30',
    danger: 'bg-[var(--color-danger)]/12 text-[var(--color-danger)] border-[var(--color-danger)]/30',
    info: 'bg-[var(--color-blue)]/12 text-[var(--color-blue)] border-[var(--color-blue)]/30',
    accent: 'bg-[var(--color-accent)] text-[var(--color-accent-ink)] border-transparent',
  }
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', tones[tone])}>{children}</span>
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" role="status" aria-label="Carregando">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[12px] text-[var(--color-muted)]">
        <span>{label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full bg-[var(--color-accent)] transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      aria-labelledby="orion-dialog-title"
      className={cx(
        'm-auto rounded-xl bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] p-0 backdrop:bg-black/60 w-[calc(100%-24px)] max-h-[90vh]',
        wide ? 'max-w-4xl' : 'max-w-lg',
      )}
    >
      {open && (
        <div className="flex flex-col max-h-[90vh]">
          <header className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
            <h2 id="orion-dialog-title" className="font-display text-base font-semibold">
              {title}
            </h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Fechar">
              ✕ Fechar
            </Button>
          </header>
          <div className="px-5 py-4 overflow-auto">{children}</div>
          {footer && <footer className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2 flex-wrap">{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string; icon?: ReactNode }>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto no-scrollbar">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-[var(--color-blue)]',
            value === t.id ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] font-medium' : 'text-[var(--color-muted)] hover:text-[var(--color-text)]',
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4 border border-dashed border-[var(--color-border)] rounded-xl">
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-[var(--color-muted)] max-w-md">{children}</div>}
      {action}
    </div>
  )
}

// ---------------------------------------------------------------- toasts
interface Toast {
  id: number
  tone: 'ok' | 'danger' | 'info'
  text: string
}
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x.slice(-3), { id, tone, text }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'danger' ? 8000 : 4000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4 left-4 sm:left-auto z-50 flex flex-col gap-2 items-end pointer-events-none">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'danger' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto max-w-sm rounded-lg border px-3.5 py-2.5 text-sm shadow-lg bg-[var(--color-surface)]',
              t.tone === 'danger' ? 'border-[var(--color-danger)]/50' : t.tone === 'ok' ? 'border-[var(--color-ok)]/50' : 'border-[var(--color-border)]',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

/** Número com vírgula decimal e ponto de milhar (pt-BR). */
export function formatDecimal(n: number, digits = 1): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

// custos dos provedores são cobrados em dólar; o formato segue o padrão brasileiro (US$ 1.234,50)
const USD = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' })

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',')} ${u[i]}`
}

export function formatCents(c: number | null | undefined): string {
  if (c === null || c === undefined) return '—'
  return USD.format(c / 100)
}
