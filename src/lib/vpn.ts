// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Lumen VPN côté interface : état partagé (barre latérale + page VPN) et actions, via le pont local (agent/vpn.ts).
import { useSyncExternalStore } from 'react'
import type { Country, Place, VpnStatus } from '../../vpn/vpn'
import { agentInfo, resetAgentInfo } from './agent'

export type { Country, Place, VpnStatus }
export type FirewallChoice = 'off' | 'fuites' | 'total'

async function call(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const { token } = await agentInfo()
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'x-lumen-token': token }, cache: 'no-store' })
  if (r.status === 401 && retry) {
    resetAgentInfo() // le serveur a redémarré : nouveau jeton
    return call(url, init, false)
  }
  return r
}
async function json<T>(r: Response): Promise<T> {
  const data = (await r.json().catch(() => ({}))) as unknown
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `Pont local indisponible (${r.status})`)
  return data as T
}

// ——— État partagé : interrogé toutes les 8 s tant qu'un composant l'affiche (1,2 s pendant une opération) ———
let current: VpnStatus | null = null
const listeners = new Set<() => void>()
let timer = 0
let fast = false
const emit = () => listeners.forEach((l) => l())

function schedule() {
  window.clearTimeout(timer)
  if (!listeners.size) return
  timer = window.setTimeout(() => (document.hidden ? schedule() : void refreshVpn()), current?.busy || fast ? 1200 : 8000)
}
/** Relit l'état ; refresh : revérifie aussi l'adresse vue par les sites (quelques secondes). */
export async function refreshVpn(refresh = false): Promise<VpnStatus | null> {
  try {
    current = await json<VpnStatus>(await call(`/agent/vpn${refresh ? '?refresh' : ''}`))
  } catch {
    /* pont indisponible (serveur qui redémarre) : on garde le dernier état */
  }
  emit()
  schedule()
  return current
}
/** Suivi rapproché pendant une action lancée depuis la page (la progression s'affiche en direct). */
export function setVpnFastPoll(on: boolean) {
  fast = on
  schedule()
}
function subscribe(l: () => void) {
  listeners.add(l)
  if (listeners.size === 1) void refreshVpn()
  return () => {
    listeners.delete(l)
    if (!listeners.size) window.clearTimeout(timer)
  }
}
export const useVpn = () => useSyncExternalStore(subscribe, () => current)

// ——— Actions ———
export async function vpnConnect(o: { country: string; system: boolean; firewall: FirewallChoice; renew?: boolean; engine?: 'tor' | 'vpngate' }): Promise<VpnStatus> {
  const r = await call('/agent/vpn', { method: 'POST', body: JSON.stringify({ action: 'connect', engine: o.engine ?? 'tor', ...o }) })
  current = await json<VpnStatus>(r)
  emit()
  schedule()
  return current
}
export async function vpnDisconnect(): Promise<VpnStatus> {
  current = await json<VpnStatus>(await call('/agent/vpn', { method: 'POST', body: JSON.stringify({ action: 'disconnect' }) }))
  emit()
  schedule()
  return current
}
export const vpnCountries = async (engine: 'tor' | 'vpngate' = 'tor') => json<Country[]>(await call(`/agent/vpn/countries?engine=${engine}`))
export const vpnRealPlace = async () => json<Place | null>(await call('/agent/vpn/real'))

/** Drapeau emoji d'un code pays (🌐 si inconnu). */
export const flag = (code?: string | null) =>
  code && /^[a-z]{2}$/i.test(code) ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐'
