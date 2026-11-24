// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Lumen VPN branché à Lumen (le moteur reste dans vpn/vpn.ts, utilisable seul) :
 *  - API de la page « VPN » de l'interface : /agent/vpn (même jeton que les autres routes du pont) ;
 *  - outil « vpn » de l'agent : lancer, arrêter, changer de pays, nouvelle adresse IP, état.
 * La page autonome (node vpn/app.ts) et Lumen partagent le même état (~/.lumen/vpn) et le même verrou.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect, countries, countryName, disconnect, realPlace, status, type Engine, type FirewallMode, type VpnStatus } from '../vpn/vpn'

type ToolResult = { ok: boolean; output: string }
type Send = (res: ServerResponse, status: number, data: unknown) => void

const engineOf = (v: unknown): Engine => (v === 'vpngate' ? 'vpngate' : 'tor')
const firewallOf = (v: unknown): 'off' | FirewallMode => (v === 'fuites' || v === 'total' ? v : 'off')

/** Phrase d'état pour le modèle (et pour l'utilisateur dans le détail de l'outil). */
export function describeVpn(s: VpnStatus): string {
  if (s.busy) return `Opération en cours : ${s.busy}`
  if (!s.connected) return `VPN arrêté : l'ordinateur utilise sa vraie position.${s.error ? ` (${s.error})` : ''}`
  const p = s.place
  const where = p ? [p.city, p.countryName].filter(Boolean).join(', ') : s.countryName
  const fw = s.firewall === 'total' ? ', coupe-circuit' : s.firewall === 'fuites' ? ', pare-feu anti-fuite' : ''
  const how = s.engine === 'tor' ? `Tor${s.system ? ', tout le Mac (navigateurs compris)' : `, proxy ${s.socks} seulement`}${fw}` : `VPN Gate (${s.server})`
  return `VPN actif : les sites voient ${where}${p?.ip ? ` (adresse ${p.ip})` : ''} — ${how}.${s.error ? ` Remarque : ${s.error}` : ''}`
}

const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '')
const enNames = new Intl.DisplayNames(['en'], { type: 'region' })

/**
 * Pays demandé par le modèle → code ISO. Accepte « de », « Allemagne », « germany », « États-Unis »…
 * '' = au plus rapide. null = pays inconnu ou sans sortie Tor.
 */
async function resolveCountry(input: unknown): Promise<string | null> {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw || /^(auto|rapide|au plus rapide|plus rapide|n'importe|nimporte|any|fastest)$/i.test(raw)) return ''
  const list = await countries('tor')
  if (/^[a-z]{2}$/i.test(raw)) return list.some((c) => c.code === raw.toLowerCase()) ? raw.toLowerCase() : null
  const want = fold(raw.replace(/^(en|au|aux|a|à)\s+/i, ''))
  for (const c of list) {
    let en = ''
    try {
      en = enNames.of(c.code.toUpperCase()) ?? ''
    } catch {
      /* code inconnu d'Intl */
    }
    if (fold(c.name) === want || fold(countryName(c.code)) === want || (en && fold(en) === want)) return c.code
  }
  return null
}

/** Outil « vpn » de l'agent. */
export async function vpnTool(a: Record<string, unknown>): Promise<ToolResult> {
  const action = String(a.action ?? 'status')
  try {
    if (action === 'status') return { ok: true, output: describeVpn(await status({ refresh: true })) }
    if (action === 'disconnect') return { ok: true, output: describeVpn(await disconnect()) }
    if (action === 'countries') {
      const list = await countries('tor')
      return { ok: true, output: `Pays disponibles (code : nom) : ${list.map((c) => `${c.code} : ${c.name}`).join(', ')}` }
    }
    if (action === 'connect' || action === 'new_ip') {
      const cur = await status()
      const on = cur.connected && cur.engine === 'tor'
      if (action === 'new_ip' && !on) return { ok: false, output: 'Le VPN est arrêté : lance-le d’abord (action « connect »).' }
      const country = action === 'new_ip' ? (cur.country ?? '') : await resolveCountry(a.country)
      if (country === null) {
        const list = await countries('tor')
        return { ok: false, output: `Pays « ${String(a.country)} » indisponible. Pays possibles : ${list.map((c) => `${c.code} (${c.name})`).join(', ')}` }
      }
      // Connecté : on garde les réglages choisis par l'utilisateur (tout le Mac, pare-feu). Sinon : tout le Mac, sans
      // pare-feu (le pare-feu demande le mot de passe administrateur : c'est à l'utilisateur de l'activer, page VPN).
      const s = await connect({
        engine: 'tor',
        country,
        system: on ? cur.system : true,
        firewall: on ? (cur.firewall ?? 'off') : 'off',
        renew: action === 'new_ip',
      })
      return { ok: s.connected, output: describeVpn(s) }
    }
    return { ok: false, output: `Action inconnue : ${action} (status, connect, disconnect, new_ip, countries)` }
  } catch (e) {
    return { ok: false, output: `VPN : ${(e as Error).message}` }
  }
}

/** Route /agent/vpn de la page VPN (le jeton est vérifié par le pont avant l'appel). */
export async function vpnRoute(req: IncomingMessage, res: ServerResponse, send: Send, readBody: (req: IncomingMessage) => Promise<unknown>) {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (req.method === 'GET') {
      if (u.pathname === '/agent/vpn') return send(res, 200, await status({ refresh: u.searchParams.has('refresh') }))
      if (u.pathname === '/agent/vpn/countries') return send(res, 200, await countries(engineOf(u.searchParams.get('engine'))))
      if (u.pathname === '/agent/vpn/real') return send(res, 200, await realPlace())
    } else if (req.method === 'POST' && u.pathname === '/agent/vpn') {
      const b = (await readBody(req)) as Record<string, unknown> | null
      if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'Requête invalide' })
      if (b.action === 'disconnect') return send(res, 200, await disconnect())
      if (b.action === 'connect') {
        return send(res, 200, await connect({ engine: engineOf(b.engine), country: String(b.country ?? ''), system: b.system === true, renew: b.renew === true, firewall: firewallOf(b.firewall) }))
      }
      return send(res, 400, { error: 'Action inconnue' })
    }
    return send(res, 404, { error: 'Introuvable' })
  } catch (e) {
    return send(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message })
  }
}
