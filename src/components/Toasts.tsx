// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { Check, Info, TriangleExclamationPoint } from 'lucide-react'
import { useStore } from '../store'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.tone === 'success' ? Check : t.tone === 'danger' ? TriangleExclamationPoint : Info
        return (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon size={14} strokeWidth={1.8} />
            <span>{t.text}</span>
          </div>
        )
      })}
    </div>
  )
}
