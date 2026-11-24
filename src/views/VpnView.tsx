// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Page « VPN » : Lumen VPN (vpn/vpn.ts) dans l'interface. Mêmes réglages que la page autonome (node vpn/app.ts).
import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, PanelLeft, Power, RefreshCw, Search, ShieldOff, Zap } from 'lucide-react'
import { useStore } from '../store'
import { Button, IconButton, Tag } from '../components/ui'
import { flag, refreshVpn, setVpnFastPoll, useVpn, vpnConnect, vpnCountries, vpnDisconnect, vpnRealPlace, type Country, type FirewallChoice, type Place } from '../lib/vpn'

// Préférences de cette page (dans le navigateur ; l'état réel de la connexion, lui, vient du serveur)
const pref = {
  get(k: string, d: boolean): boolean {
    try {
      const v = localStorage.getItem(`lumen.vpn.${k}`)
      return v === null ? d : v === '1'
    } catch {
      return d
    }
  },
  set(k: string, v: boolean | string) {
    try {
      localStorage.setItem(`lumen.vpn.${k}`, typeof v === 'boolean' ? (v ? '1' : '0') : v)
    } catch {
      /* stockage indisponible : préférence non retenue */
    }
  },
  country(): string {
    try {
      return localStorage.getItem('lumen.vpn.pays') ?? ''
    } catch {
      return ''
    }
  },
}
const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const placeText = (p?: Place | null) => (p ? [p.city, p.countryName].filter(Boolean).join(', ') : '')
function duration(since: number) {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min ${String(s % 60).padStart(2, '0')} s`
}
const fwMode = (sys: boolean, fw: boolean, kill: boolean): FirewallChoice => (sys && fw ? (kill ? 'total' : 'fuites') : 'off')

export function VpnView() {
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const st = useVpn()
  const [engine, setEngine] = useState<'tor' | 'vpngate'>('tor')
  const [list, setList] = useState<Country[] | null>(null)
  const [real, setReal] = useState<Place | null>(null)
  const [q, setQ] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sysPref, setSysPref] = useState(() => pref.get('tout-le-mac', true))
  const [fwPref, setFwPref] = useState(() => pref.get('pare-feu', false))
  const [killPref, setKillPref] = useState(() => pref.get('coupe-circuit', false))
  const [, tick] = useState(0)

  const on = !!st?.connected
  const torOn = on && st?.engine === 'tor'
  const busy = st?.busy ?? pending
  // Connecté : les interrupteurs montrent l'état réel ; sinon, ce qui sera appliqué à la prochaine connexion.
  const sys = engine === 'vpngate' ? true : torOn ? !!st?.system : sysPref
  const fw = torOn ? !!st?.firewall : sysPref && fwPref
  const kill = torOn ? st?.firewall === 'total' : sysPref && fwPref && killPref

  useEffect(() => {
    void refreshVpn(true)
    vpnRealPlace().then(setReal, () => {})
  }, [])
  useEffect(() => {
    if (on && st?.engine) setEngine(st.engine)
  }, [on, st?.engine])
  useEffect(() => {
    setList(null)
    vpnCountries(engine).then(setList, (e: Error) => setError(e.message))
  }, [engine])
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [on])

  async function act(label: string, fn: () => Promise<unknown>) {
    if (busy) return
    setPending(label)
    setError(null)
    setVpnFastPoll(true)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(null)
      setVpnFastPoll(false)
      void refreshVpn()
    }
  }
  const connectTo = (country: string, o: { sys?: boolean; fw?: boolean; kill?: boolean; renew?: boolean } = {}) => {
    const s = o.sys ?? sys
    const f = o.fw ?? fw
    const k = o.kill ?? kill
    pref.set('pays', country)
    return act(o.renew ? 'Nouvelle adresse IP…' : country ? 'Connexion…' : 'Recherche du pays le plus rapide…', () =>
      vpnConnect({ engine, country, system: engine === 'tor' && s, firewall: engine === 'tor' ? fwMode(s, f, k) : 'off', renew: o.renew }),
    )
  }
  // Un réglage changé pendant une connexion Tor s'applique tout de suite (même pays).
  const toggle = (key: 'sys' | 'fw' | 'kill') => {
    if (busy) return
    const next = { sys, fw, kill, [key]: !{ sys, fw, kill }[key] }
    if (key === 'kill' && next.kill) next.fw = true
    if (key === 'fw' && !next.fw) next.kill = false
    setSysPref(next.sys)
    setFwPref(next.fw)
    setKillPref(next.kill)
    pref.set('tout-le-mac', next.sys)
    pref.set('pare-feu', next.fw)
    pref.set('coupe-circuit', next.kill)
    if (torOn) void connectTo(st?.country ?? '', next)
  }

  const shown = useMemo(() => {
    const f = fold(q.trim())
    return (list ?? []).filter((c) => !f || fold(c.name).includes(f) || c.code === f)
  }, [list, q])
  const cells = on
    ? [['IP vue par les sites', st?.place?.ip], ['Lieu', placeText(st?.place) || st?.countryName], ['Opérateur', st?.place?.org], ['Durée', st?.since ? duration(st.since) : '']]
    : [['Adresse IP réelle', real?.ip], ['Lieu réel', placeText(real)], ['Opérateur', real?.org], ['Durée', '—']]
  const notice = error ?? st?.error ?? null

  return (
    <div className="page">
      <div className="page-main">
        <div className="page-head">
          {!sidebarOpen && <IconButton icon={PanelLeft} label="Afficher la barre latérale" onClick={() => useStore.getState().toggleSidebar()} />}
          <div className="page-head-text">
            <h1 className="h1">VPN</h1>
            <span className="secondary">Change la position vue par les sites · Claude et les modèles locaux restent en direct</span>
          </div>
          {st && <Tag tone={on ? 'success' : 'neutral'}>{on ? 'Protégé' : 'Non protégé'}</Tag>}
        </div>

        <div className="vpn-grid">
          <section className="vpn-card">
            <div className="vpn-hero">
              <button
                type="button"
                className={`vpn-power${on ? ' is-on' : ''}${busy ? ' is-busy' : ''}`}
                disabled={!!busy || !st}
                aria-label={on ? 'Arrêter le VPN' : 'Lancer le VPN'}
                onClick={() => (on ? void act('Arrêt…', vpnDisconnect) : void connectTo(pref.country()))}
              >
                {busy ? <LoaderCircle size={30} strokeWidth={1.6} /> : <Power size={30} strokeWidth={1.6} />}
              </button>
              <div className="vpn-state">
                <span className="vpn-title">{busy ?? (on ? `${flag(st?.place?.country || st?.country)} ${placeText(st?.place) || st?.countryName}` : 'Non connecté')}</span>
                <span className="caption muted">
                  {busy
                    ? 'Patiente quelques secondes…'
                    : on
                      ? st?.engine === 'tor'
                        ? `Tor${st.system ? ' · tout le Mac' : ' · proxy seulement'}${st.firewall === 'total' ? ' · coupe-circuit' : st.firewall === 'fuites' ? ' · pare-feu' : ''}`
                        : `VPN Gate · ${st?.server ?? ''}`
                      : real
                        ? `Position réelle : ${placeText(real)}`
                        : 'Position réelle…'}
                </span>
              </div>
            </div>

            <div className="vpn-info">
              {cells.map(([k, v]) => (
                <div key={k} className="vpn-cell">
                  <span className="overline">{k}</span>
                  <span className="mono-sm ellipsis">{v || '—'}</span>
                </div>
              ))}
            </div>

            {st?.available.vpngate && (
              <div className="segmented seg-full" role="tablist" aria-label="Moteur">
                {(['tor', 'vpngate'] as const).map((e) => (
                  <button key={e} type="button" className={engine === e ? 'is-on' : ''} disabled={!!busy || on} onClick={() => setEngine(e)}>
                    {e === 'tor' ? 'Tor · gratuit' : 'VPN Gate · mot de passe'}
                  </button>
                ))}
              </div>
            )}

            {engine === 'tor' && (
              <div className="vpn-options">
                <button type="button" className="toggle-row" disabled={!!busy} onClick={() => toggle('sys')} aria-pressed={sys}>
                  <span className="toggle-text">
                    <span className="label-sm">Tout le Mac</span>
                    <span className="caption muted">Chrome, Safari, Dia… changent de pays (sans ça : proxy SOCKS seulement)</span>
                  </span>
                  <span className={`switch${sys ? ' is-on' : ''}`}>
                    <i />
                  </span>
                </button>
                <button type="button" className="toggle-row" disabled={!!busy || !sys} onClick={() => toggle('fw')} aria-pressed={fw}>
                  <span className="toggle-text">
                    <span className="label-sm">Pare-feu anti-fuite</span>
                    <span className="caption muted">Bloque WebRTC et l’UDP hors VPN · mot de passe à l’activation seulement</span>
                  </span>
                  <span className={`switch${fw ? ' is-on' : ''}`}>
                    <i />
                  </span>
                </button>
                <button type="button" className="toggle-row" disabled={!!busy || !sys} onClick={() => toggle('kill')} aria-pressed={kill}>
                  <span className="toggle-text">
                    <span className="label-sm">Coupe-circuit total</span>
                    <span className="caption muted">Seuls Tor et Claude sortent (Mail, App Store… coupés) · retiré tout seul si Tor s’arrête</span>
                  </span>
                  <span className={`switch${kill ? ' is-on' : ''}`}>
                    <i />
                  </span>
                </button>
              </div>
            )}

            {on && (
              <div className="row vpn-actions">
                {torOn && (
                  <Button small icon={RefreshCw} disabled={!!busy} onClick={() => void connectTo(st?.country ?? '', { renew: true })}>
                    Nouvelle adresse IP
                  </Button>
                )}
                <Button small variant="ghost" icon={ShieldOff} disabled={!!busy} onClick={() => void act('Arrêt…', vpnDisconnect)}>
                  Arrêter
                </Button>
              </div>
            )}

            {notice && !busy && <p className="caption vpn-notice">{notice}</p>}
            <p className="caption muted vpn-hint">Tu peux aussi le demander à Lumen : « mets-moi en Allemagne », « change de pays », « arrête le VPN ».</p>
          </section>

          <section className="vpn-countries">
            <div className="input-icon">
              <Search size={14} className="muted" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un pays…" aria-label="Rechercher un pays" />
            </div>
            <span className="overline">{list ? `${list.length} pays disponibles` : 'Chargement des pays…'}</span>
            <div className="vpn-list">
              {!q && engine === 'tor' && (
                <button type="button" className={`vpn-country${on && !st?.country ? ' is-current' : ''}`} disabled={!!busy} onClick={() => void connectTo('')}>
                  <span className="vpn-flag">
                    <Zap size={16} strokeWidth={1.7} />
                  </span>
                  <span className="vpn-cname">
                    <span className="label-sm">Au plus rapide</span>
                    <span className="caption muted">Le pays le plus rapide du moment</span>
                  </span>
                  {on && !st?.country && <Tag tone="success">Actuel</Tag>}
                </button>
              )}
              {shown.map((c) => {
                const cur = on && st?.country === c.code
                return (
                  <button key={c.code} type="button" className={`vpn-country${cur ? ' is-current' : ''}`} disabled={!!busy} onClick={() => void connectTo(c.code)}>
                    <span className="vpn-flag">{flag(c.code)}</span>
                    <span className="vpn-cname">
                      <span className="label-sm">{c.name}</span>
                      {c.servers > 0 && <span className="caption muted">{c.servers} {engine === 'tor' ? 'relais de sortie' : 'serveurs'}</span>}
                    </span>
                    {cur && <Tag tone="success">Actuel</Tag>}
                  </button>
                )
              })}
              {list && !shown.length && <p className="caption muted">Aucun pays ne correspond.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
