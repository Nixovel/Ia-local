// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react'
import { Sparkles, type LucideIcon } from 'lucide-react'
import { letterFor, toneFor, type Tone } from '../lib/models'
import { copyText } from '../lib/files'

export function Tag({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`tag tone-${tone}`} title={title}>
      {children}
    </span>
  )
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon
  label: string
  variant?: 'ghost' | 'subtle' | 'accent'
  size?: number
  active?: boolean
}

export function IconButton({ icon: Icon, label, variant = 'ghost', size = 16, active, className = '', ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`ibtn ibtn-${variant}${active ? ' is-active' : ''} ${className}`}
      title={label}
      aria-label={label}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.6} />
    </button>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  small?: boolean
}

export function Button({ icon: Icon, variant = 'secondary', small, children, className = '', ...rest }: ButtonProps) {
  return (
    <button type="button" className={`btn btn-${variant}${small ? ' btn-sm' : ''} ${className}`} {...rest}>
      {Icon && <Icon size={small ? 14 : 16} strokeWidth={1.7} />}
      {children != null && <span>{children}</span>}
    </button>
  )
}

export function Logo({ size = 28, glow }: { size?: number; glow?: boolean }) {
  return (
    <span className={`logo${glow ? ' logo-glow' : ''}`} style={{ width: size, height: size, borderRadius: size * 0.29 }}>
      <Sparkles size={Math.round(size * 0.56)} strokeWidth={0} fill="currentColor" />
    </span>
  )
}

export function LetterTile({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className={`ltile tone-${toneFor(name)}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}>
      {letterFor(name)}
    </span>
  )
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>

export const StatusDot = ({ tone = 'success', pulse }: { tone?: Tone; pulse?: boolean }) => (
  <span className={`dot tone-${tone}${pulse ? ' dot-pulse' : ''}`} />
)

/** Barre empilée : chaque part est une fraction du total (ex. mémoire des modèles, puis du reste du système). */
export function StackMeter({ parts, label }: { parts: { value: number; className: string; title?: string }[]; label?: string }) {
  let left = 1
  return (
    <div className="meter-stack" role="img" aria-label={label}>
      {parts.map((p, i) => {
        const v = Math.max(0, Math.min(left, p.value || 0))
        left -= v
        return <i key={i} className={p.className} style={{ width: `${v * 100}%` }} title={p.title} />
      })}
    </div>
  )
}

export function Meter({ value, tone = 'accent' }: { value: number; tone?: Tone }) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100
  return (
    <div className="meter">
      <div className={`meter-fill tone-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function useCopy(timeout = 1600): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout>>(undefined)
  const copy = useCallback(
    async (text: string) => {
      if (await copyText(text)) {
        setCopied(true)
        clearTimeout(t.current)
        t.current = setTimeout(() => setCopied(false), timeout)
      }
    },
    [timeout],
  )
  useEffect(() => () => clearTimeout(t.current), [])
  return [copied, copy]
}

export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOutside()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, onOutside, enabled])
}

/** Bouton qui demande un second clic pour confirmer une action destructive. */
export function useArmed(ms = 2500): [boolean, () => boolean] {
  const [armed, setArmed] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(t.current), [])
  const trigger = useCallback(() => {
    if (armed) {
      setArmed(false)
      return true
    }
    setArmed(true)
    clearTimeout(t.current)
    t.current = setTimeout(() => setArmed(false), ms)
    return false
  }, [armed, ms])
  return [armed, trigger]
}
