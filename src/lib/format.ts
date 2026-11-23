// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
const nf = (v: number, digits = 1) => v.toLocaleString('fr-FR', { maximumFractionDigits: digits })

export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 o'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  const v = n / 1024 ** i
  return `${nf(v, i >= 2 ? 1 : 0)} ${units[i]}`
}

export const compact = (n: number) => (n >= 1000 ? `${nf(n / 1000)}k` : String(n))

export const formatSeconds = (s: number) =>
  s < 60 ? `${nf(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`

export const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

export function dayGroup(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((today.getTime() - day) / 86_400_000)
  if (diff <= 0) return "Aujourd'hui"
  if (diff === 1) return 'Hier'
  if (diff < 7) return '7 derniers jours'
  if (diff < 30) return '30 derniers jours'
  return 'Plus ancien'
}

export function momentOfDay(): string {
  const h = new Date().getHours()
  if (h < 5) return 'cette nuit'
  if (h < 12) return 'ce matin'
  if (h < 18) return 'cet après-midi'
  return 'ce soir'
}

export const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

export const fr = nf
