// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Lumen VPN — change la localisation apparente de la connexion, façon NordVPN. Module autonome : il n'est pas encore
 * branché à Lumen (ni agent/bridge.ts, ni l'interface). On le lance avec `node vpn/app.ts` (page + API) ou en ligne
 * de commande (`node vpn/app.ts on fr`). Deux moteurs :
 *  - « tor » (par défaut) : Tor avec un pays de sortie imposé (ExitNodes {xx} + StrictNodes 1). ≈ 50 pays, gratuit,
 *    sans mot de passe. Proxy SOCKS5 sur 127.0.0.1:9450. Option « tout le Mac » : proxy SOCKS système de macOS
 *    (navigateurs et apps qui suivent les réglages réseau) ; les réglages d'avant sont remis à la déconnexion.
 *    Changer de pays ne relance pas Tor : SETCONF ExitNodes + SIGNAL NEWNYM + fermeture des circuits ouverts.
 *  - « vpngate » : vrai VPN (OpenVPN, tout le trafic du Mac) via les serveurs bénévoles de VPN Gate (université de
 *    Tsukuba). Peu de pays (surtout Japon et Corée). Créer l'interface réseau demande les droits administrateur :
 *    macOS affiche sa propre fenêtre de mot de passe, remplie par l'utilisateur. La déconnexion passe par l'interface
 *    de gestion d'OpenVPN (127.0.0.1:9452, mot de passe aléatoire) : pas de deuxième mot de passe.
 * Tor et OpenVPN tournent détachés : la connexion survit au redémarrage du serveur, l'état est relu depuis le disque.
 * Jamais d'Internet coupé (« Wi-Fi connecté mais plus d'Internet ») :
 *  - Claude passe toujours en direct : ses domaines sont exclus du proxy de macOS et ses adresses permises par le pare-feu.
 *  - Deux gardes détachés, indépendants de la page et du serveur : le garde du proxy (utilisateur) remet le proxy
 *    d'avant si Tor s'arrête plus de 15 s, et aussi à l'extinction du Mac (SIGTERM) ; le garde du pare-feu (root, lancé
 *    avec le même mot de passe) retire les règles si Tor s'arrête, si la vérification qui suit l'activation n'a pas
 *    confirmé que Claude et Tor passent (90 s), ou à la demande (déconnexion sans deuxième mot de passe).
 *  - Après un redémarrage du Mac, status() voit l'état périmé et remet le proxy d'avant (rien n'est relancé).
 * Fichiers : ~/.lumen/vpn (torrc, données Tor, état, journaux, config OpenVPN, listes de pays en cache).
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { closeSync, existsSync, openSync, promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export type Engine = 'tor' | 'vpngate'
export type Place = { ip: string; city?: string; region?: string; country?: string; countryName?: string; org?: string }
export type Country = { code: string; name: string; servers: number; weight: number }
/** bypass : exceptions du proxy (« ne pas utiliser de proxy pour »), notées pour être remises telles quelles. */
type ProxySetting = { enabled: boolean; server: string; port: number; bypass?: string[] }
type VpnState = {
  engine: Engine
  pid: number
  /** Code ISO en minuscules ; '' = « au plus rapide » (n'importe quel pays). */
  country: string
  system: boolean
  since: number
  prevProxy?: Record<string, ProxySetting>
  server?: string
  place?: Place | null
  before?: Place | null
  /** VPN Gate : dossier de travail d'OpenVPN, créé par root (/private/var/tmp/lumen-vpn.XXXXXX). */
  dir?: string
  /** Relances automatiques de Tor depuis la connexion (au-delà de 3, on abandonne et on remet le proxy d'avant). */
  restarts?: number
  /** Pare-feu pf chargé pour cette connexion (jeton de pfctl -E ; vide si le chargement n'a pas abouti). */
  firewall?: Firewall
  /** Garde du proxy (pid) : remet le proxy d'avant si Tor s'arrête ou si le Mac s'éteint. */
  guard?: number
}
export type VpnStatus = {
  connected: boolean
  engine: Engine | null
  country: string | null
  countryName: string | null
  system: boolean
  firewall: 'fuites' | 'total' | null
  since: number | null
  server: string | null
  place: Place | null
  socks: string | null
  busy: string | null
  error: string | null
  available: { tor: boolean; vpngate: boolean; system: boolean }
}

export const VPN_DIR = path.join(os.homedir(), '.lumen', 'vpn')
export const SOCKS_PORT = 9450
const CONTROL_PORT = 9451
const MGMT_PORT = 9452
const F = {
  state: path.join(VPN_DIR, 'state.json'),
  torrc: path.join(VPN_DIR, 'torrc'),
  torData: path.join(VPN_DIR, 'tor-data'),
  torLog: path.join(VPN_DIR, 'tor.log'),
  torCountries: path.join(VPN_DIR, 'pays-tor.json'),
  excluded: path.join(VPN_DIR, 'sorties-exclues.json'),
  gateList: path.join(VPN_DIR, 'vpngate.csv'),
  mgmtPw: path.join(VPN_DIR, 'gestion.pw'),
  lock: path.join(VPN_DIR, 'verrou.json'),
  /** pid de Tor, surveillé par les gardes (réécrit à chaque lancement de Tor). */
  torPid: path.join(VPN_DIR, 'tor.pid'),
  /** Commandes qui remettent le proxy d'avant ; le garde du proxy s'arrête tout seul quand ce fichier disparaît. */
  restore: path.join(VPN_DIR, 'proxy-restaurer.sh'),
  /** Contient le pid du garde du pare-feu : la vérification après activation a réussi (sinon retrait au bout de 90 s). */
  fwOk: path.join(VPN_DIR, 'pare-feu.ok'),
  /** Contient le pid du garde du pare-feu : demande de retrait des règles (déconnexion sans mot de passe). */
  fwRelease: path.join(VPN_DIR, 'pare-feu.retirer'),
}
/** Secondes sans Tor avant que les gardes rendent Internet (laisse le temps à une relance automatique). */
const GUARD_GRACE_S = 15
/** Secondes laissées à la vérification qui suit l'activation du pare-feu avant qu'il se retire tout seul. */
const FW_CONFIRM_S = 90
const PROXY_GUARD_TAG = 'lumen-vpn-garde'
const PF_GUARD_TAG = 'lumen-pf-garde'
/** Claude ne passe jamais par Tor (Cloudflare, connexion à ton compte) : exceptions du proxy de macOS. */
export const CLAUDE_DOMAINS = ['claude.ai', '*.claude.ai', 'claude.com', '*.claude.com', 'anthropic.com', '*.anthropic.com', '*.claudeusercontent.com']
/** Plages publiées d'Anthropic (claude.ai, api.anthropic.com) + noms résolus à l'activation : permis par le pare-feu. */
const ANTHROPIC_NETS = ['160.79.104.0/23', '2607:6bc0::/48']
const CLAUDE_HOSTS = ['claude.ai', 'api.anthropic.com', 'claude.com', 'anthropic.com', 'www.anthropic.com', 'a-api.anthropic.com', 'statsig.anthropic.com', 's-cdn.anthropic.com', 'a-cdn.claude.ai']
const isMac = process.platform === 'darwin'
/** Pays de repli si la liste des sorties Tor (Onionoo) est injoignable. */
const TOR_FALLBACK = ['at', 'bg', 'ca', 'ch', 'cz', 'de', 'dk', 'fi', 'fr', 'gb', 'hk', 'is', 'it', 'lu', 'md', 'nl', 'no', 'pl', 'ro', 'rs', 'se', 'sg', 'ua', 'us', 'za']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Erreur avec code HTTP pour le serveur : 400 = demande invalide, 409 = une opération est déjà en cours. */
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status })
const regionNames = new Intl.DisplayNames(['fr'], { type: 'region' })
export function countryName(code: string): string {
  if (!code) return 'Au plus rapide'
  try {
    return regionNames.of(code.toUpperCase()) ?? code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}
const cleanCountry = (c: unknown) => (typeof c === 'string' && /^[a-z]{2}$/i.test(c) ? c.toLowerCase() : '')
/** Code ISO 3166 réel ? (« zz » = région inconnue ; un code inexistant est rendu tel quel par Intl) */
const knownCountry = (c: string) => c !== 'zz' && countryName(c) !== c.toUpperCase()

function findBin(name: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/usr/sbin']
  for (const d of dirs) {
    if (d && existsSync(path.join(d, name))) return path.join(d, name)
  }
  return null
}

function run(cmd: string, args: string[], timeoutMs = 30_000, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    const abort = () => p.kill('SIGKILL')
    signal?.addEventListener('abort', abort, { once: true })
    const done = (code: number, err = '') => {
      clearTimeout(t)
      signal?.removeEventListener('abort', abort)
      resolve({ code, stdout, stderr: stderr + err })
    }
    p.on('error', (e) => done(-1, String(e)))
    p.on('close', (code) => done(code ?? -1))
  })
}

async function tail(file: string, n = 5): Promise<string> {
  try {
    return (await fs.readFile(file, 'utf8')).trim().split('\n').slice(-n).join('\n')
  } catch {
    return ''
  }
}

// ——— État sur disque ———

async function readState(): Promise<VpnState | null> {
  try {
    return JSON.parse(await fs.readFile(F.state, 'utf8')) as VpnState
  } catch {
    return null
  }
}
let dirReady = false
/** ~/.lumen/vpn en 0700 : l'état contient l'adresse IP réelle, personne d'autre n'a à le lire. */
async function ensureDir() {
  if (dirReady) return
  await fs.mkdir(VPN_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(VPN_DIR, 0o700)
  dirReady = true
}
async function writeState(s: VpnState | null) {
  await ensureDir()
  if (!s) return fs.rm(F.state, { force: true })
  // Écriture atomique : un autre processus (page ou ligne de commande) ne lit jamais un fichier à moitié écrit.
  const tmp = `${F.state}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  await fs.rename(tmp, F.state)
}
function alive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // processus d'un autre utilisateur (OpenVPN tourne en root)
  }
}
/** Le processus noté dans l'état est-il toujours le bon (et pas un numéro recyclé par un autre programme) ? */
function running(s: VpnState | null): boolean {
  if (!s || !alive(s.pid)) return false
  const r = spawnSync('/bin/ps', ['-p', String(s.pid), '-o', 'comm='], { encoding: 'utf8' })
  const name = path.basename((r.stdout ?? '').trim())
  // Si ps lui-même échoue (rare), on se fie à alive() : couper le VPN sur une fausse alerte serait pire.
  if (r.error || !name) return true
  return name === (s.engine === 'tor' ? 'tor' : 'openvpn')
}
async function killPid(pid: number, ms = 6000) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const t0 = Date.now()
  while (alive(pid) && Date.now() - t0 < ms) await sleep(200)
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* déjà parti */
    }
  }
}
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}

// ——— Progression (lue par l'interface pendant une connexion) ———

let busy: string | null = null
let lastError: string | null = null
const step = (msg: string) => {
  busy = msg
  if (ownLock) fs.writeFile(F.lock, JSON.stringify({ pid: process.pid, msg })).catch(() => {}) // visible des autres processus
}

// ——— Verrou commun à tous les processus ———
// Le serveur de la page et la ligne de commande partagent state.json : une seule opération à la fois sur la machine.
// Le verrou contient le pid et l'étape en cours, ce qui permet aussi d'afficher la progression d'un autre processus.

let ownLock = false
async function readLock(): Promise<{ pid: number; msg: string } | null> {
  try {
    return JSON.parse(await fs.readFile(F.lock, 'utf8')) as { pid: number; msg: string }
  } catch {
    return null
  }
}
async function takeLock(msg: string): Promise<boolean> {
  if (ownLock) return false // déjà pris par une autre opération de ce même processus
  await ensureDir()
  for (let i = 0; i < 3; i++) {
    try {
      await fs.writeFile(F.lock, JSON.stringify({ pid: process.pid, msg }), { flag: 'wx', mode: 0o600 })
      ownLock = true
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const l = await readLock()
      if (l ? alive(l.pid) : await fs.stat(F.lock).then((st) => Date.now() - st.mtimeMs < 5000, () => false)) return false
      await fs.rm(F.lock, { force: true }) // verrou abandonné par un processus mort
    }
  }
  return false
}
async function dropLock() {
  if (!ownLock) return
  ownLock = false
  await fs.rm(F.lock, { force: true })
}
/** Étape en cours dans un AUTRE processus (null si aucun). */
async function otherBusy(): Promise<string | null> {
  const l = await readLock()
  return l && l.pid !== process.pid && alive(l.pid) ? l.msg || 'Opération en cours…' : null
}

// ——— Position (adresse IP publique et géolocalisation) ———

type Json = Record<string, unknown>
const GEO: { url: string; map: (j: Json) => Json }[] = [
  { url: 'https://ipinfo.io/json', map: (j) => ({ ip: j.ip, city: j.city, region: j.region, country: j.country, org: j.org }) },
  { url: 'https://ipapi.co/json/', map: (j) => ({ ip: j.ip, city: j.city, region: j.region, country: j.country_code, org: j.org }) },
  { url: 'https://api.ip.sb/geoip', map: (j) => ({ ip: j.ip, city: j.city, region: j.region, country: j.country_code, org: j.organization }) },
]
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * Adresse publique vue par Internet, directement ou à travers Tor. Les services sont interrogés en même temps : le
 * premier qui répond gagne et les autres requêtes sont coupées (une vérification dure au plus `timeoutS` secondes).
 */
export async function whereAmI(viaTor = false, timeoutS = 12): Promise<Place | null> {
  const curl = findBin('curl') ?? 'curl'
  const proxy = viaTor ? ['--socks5-hostname', `127.0.0.1:${SOCKS_PORT}`] : []
  const stop = new AbortController()
  const get = (url: string) => run(curl, [...proxy, '-s', '-m', String(timeoutS), url], (timeoutS + 3) * 1000, stop.signal).then((r) => JSON.parse(r.stdout) as Json)
  // Certains services refusent les sorties Tor : adresse via le service de Tor, pays via la base GeoIP de Tor.
  const torCheck = viaTor
    ? get('https://check.torproject.org/api/ip').then(async (j) => {
        const ip = str(j.IP)
        if (!ip) throw new Error('pas d’adresse')
        const country = (await ipCountry(ip)) ?? ''
        return { ip, country, countryName: country ? countryName(country) : undefined } as Place
      })
    : null
  torCheck?.catch(() => {}) // évite un rejet non suivi si un service de géolocalisation répond avant
  try {
    return await Promise.any(
      GEO.map((g) =>
        get(g.url).then((j) => {
          const m = g.map(j)
          const ip = str(m.ip)
          if (!ip) throw new Error('pas d’adresse')
          const country = cleanCountry(m.country)
          return { ip, city: str(m.city), region: str(m.region), country, countryName: country ? countryName(country) : undefined, org: str(m.org) } as Place
        }),
      ),
    )
  } catch {
    return torCheck ? await torCheck.catch(() => null) : null
  } finally {
    stop.abort()
  }
}

let real: { at: number; place: Place | null } | null = null
/** Position réelle (sans VPN). Avec VPN Gate actif, tout passe par le tunnel : on rend celle notée avant la connexion. */
export async function realPlace(): Promise<Place | null> {
  const s = await readState()
  if (s && s.engine === 'vpngate' && running(s)) return s.before ?? real?.place ?? null
  if (!real || Date.now() - real.at > 10 * 60_000) real = { at: Date.now(), place: await whereAmI(false) }
  return real.place
}

// ——— Sorties Tor par pays, d'après les données de Tor lui-même (hors ligne) ———
// ExitNodes {xx} s'appuie sur la base GeoIP de Tor : en croisant le consensus en cache (relais « Exit ») avec cette
// base, on sait exactement quels pays ont des sorties, et avec quelle bande passante, sans rien demander au réseau.

/** Base GeoIP IPv4 de Tor en tableaux compacts (≈ 4 Mo) : plages [lo, hi] et code pays sur 2 octets. */
type GeoDb = { lo: Uint32Array; hi: Uint32Array; cc: Uint16Array }
let geoDb: Promise<GeoDb | null> | null = null
function geoipPath(): string | null {
  const tor = findBin('tor')
  const p = tor ? path.join(path.dirname(path.dirname(tor)), 'share', 'tor', 'geoip') : ''
  return p && existsSync(p) ? p : null
}
function loadGeoip(): Promise<GeoDb | null> {
  geoDb ??= (async () => {
    const file = geoipPath()
    if (!file) return null
    // Lecture caractère par caractère, sans découper en 400 000 chaînes (fichier de ≈ 10 Mo).
    const t = await fs.readFile(file, 'latin1')
    const max = Math.ceil(t.length / 8) // chaque ligne utile fait au moins 8 caractères (« 0,0,XX\n »)
    const lo = new Uint32Array(max)
    const hi = new Uint32Array(max)
    const cc = new Uint16Array(max)
    let i = 0
    let pos = 0
    while (pos < t.length) {
      let end = t.indexOf('\n', pos)
      if (end < 0) end = t.length
      if (t.charCodeAt(pos) !== 35 /* # */) {
        let k = pos
        let a = 0
        let b = 0
        for (let c = t.charCodeAt(k); c >= 48 && c <= 57; c = t.charCodeAt(++k)) a = a * 10 + c - 48
        if (t.charCodeAt(k) === 44 /* , */) {
          for (let c = t.charCodeAt(++k); c >= 48 && c <= 57; c = t.charCodeAt(++k)) b = b * 10 + c - 48
          if (t.charCodeAt(k) === 44 && k + 2 < end) {
            lo[i] = a
            hi[i] = b
            cc[i++] = ((t.charCodeAt(k + 1) | 32) << 8) | (t.charCodeAt(k + 2) | 32) // en minuscules
          }
        }
      }
      pos = end + 1
    }
    return { lo: lo.slice(0, i), hi: hi.slice(0, i), cc: cc.slice(0, i) }
  })()
  return geoDb
}
/** Pays d'une adresse IPv4 selon la base GeoIP de Tor (null si inconnue). */
export async function ipCountry(ip: string): Promise<string | null> {
  const db = await loadGeoip()
  const parts = ip.split('.').map(Number)
  if (!db || parts.length !== 4 || parts.some((x) => !(x >= 0 && x <= 255))) return null
  const n = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  let a = 0
  let b = db.lo.length - 1
  while (a <= b) {
    const m = (a + b) >> 1
    if (n < db.lo[m]) b = m - 1
    else if (n > db.hi[m]) a = m + 1
    else return cleanCountry(String.fromCharCode(db.cc[m] >> 8, db.cc[m] & 0xff)) || null
  }
  return null
}

const CONSENSUS = path.join(F.torData, 'cached-microdesc-consensus')
type ExitRelay = { ip: string; bw: number; country: string }
let relaysCache: { mtime: number; list: ExitRelay[] } | null = null
/** Relais de sortie utilisables du dernier consensus, avec leur pays selon Tor (null si absent ou de plus de 3 jours). */
async function consensusExits(): Promise<ExitRelay[] | null> {
  let mtime: number
  try {
    mtime = (await fs.stat(CONSENSUS)).mtimeMs
  } catch {
    return null
  }
  if (Date.now() - mtime > 3 * 86400_000) return null
  if (relaysCache?.mtime === mtime) return relaysCache.list
  if (!(await loadGeoip())) return null
  const list: ExitRelay[] = []
  let ip = ''
  let flags = ''
  for (const line of (await fs.readFile(CONSENSUS, 'utf8')).split('\n')) {
    if (line.startsWith('r ')) {
      ip = line.split(' ')[5] ?? ''
      flags = ''
    } else if (line.startsWith('s ')) flags = line
    else if (line.startsWith('w ')) {
      if (ip && /\bExit\b/.test(flags) && !/\bBadExit\b/.test(flags) && /\bRunning\b/.test(flags)) {
        const country = await ipCountry(ip)
        if (country) list.push({ ip, bw: Number(/Bandwidth=(\d+)/.exec(line)?.[1] ?? 0), country })
      }
      ip = ''
    }
  }
  relaysCache = { mtime, list }
  return list
}

let exitsCache: { key: string; map: Map<string, Country> } | null = null
/** Sorties Tor par pays, sans les sorties exclues (null si Tor n'a jamais tourné ou si le consensus est trop vieux). */
export async function torExits(): Promise<Map<string, Country> | null> {
  const relays = await consensusExits()
  if (!relays) return null
  const excluded = await readExcluded()
  const key = `${relaysCache?.mtime}|${JSON.stringify(excluded)}`
  if (exitsCache?.key === key) return exitsCache.map
  const map = new Map<string, Country>()
  let total = 0
  for (const r of relays) {
    if (isExcluded(r, excluded)) continue
    const c = map.get(r.country) ?? { code: r.country, name: countryName(r.country), servers: 0, weight: 0 }
    c.servers++
    c.weight += r.bw
    total += r.bw
    map.set(r.country, c)
  }
  for (const c of map.values()) c.weight = total ? c.weight / total : 0 // part de la bande passante de sortie (0 à 1)
  exitsCache = { key, map }
  return map
}

// ——— Tor ———

/** Envoie des commandes au port de contrôle de Tor (authentification par cookie) ; rend la réponse de chacune. */
function torCtl(cmds: string[]): Promise<string[][]> {
  return fs.readFile(path.join(F.torData, 'control_auth_cookie')).then(
    (cookie) =>
      new Promise((resolve, reject) => {
        const sock = net.connect(CONTROL_PORT, '127.0.0.1')
        const queue = [`AUTHENTICATE ${cookie.toString('hex')}`, ...cmds, 'QUIT']
        const replies: string[][] = []
        let cur: string[] = []
        let buf = ''
        let inData = false
        const timer = setTimeout(() => {
          sock.destroy()
          reject(new Error('Tor ne répond pas sur son port de contrôle'))
        }, 15_000)
        const next = () => {
          const c = queue.shift()
          if (c !== undefined) sock.write(c + '\r\n')
        }
        sock.on('connect', next)
        sock.on('data', (d) => {
          buf += d.toString('utf8')
          let i: number
          while ((i = buf.indexOf('\r\n')) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 2)
            if (inData) {
              if (line === '.') inData = false
              else cur.push(line)
              continue
            }
            cur.push(line)
            if (/^\d{3}\+/.test(line)) inData = true
            else if (/^\d{3} /.test(line)) {
              replies.push(cur)
              cur = []
              if (line[0] !== '2') {
                clearTimeout(timer)
                sock.destroy()
                reject(new Error(`Tor : ${line.slice(4)}`))
                return
              }
              next()
            }
          }
        })
        sock.on('close', () => {
          clearTimeout(timer)
          resolve(replies.slice(1, 1 + cmds.length))
        })
        sock.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
      }),
  )
}

const quote = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

async function startTor(country: string): Promise<number> {
  const tor = findBin('tor')
  if (!tor) throw new Error("Tor n'est pas installé (brew install tor)")
  if (await portBusy(SOCKS_PORT)) throw new Error(`Le port ${SOCKS_PORT} est déjà utilisé par un autre programme`)
  await fs.mkdir(F.torData, { recursive: true })
  await fs.chmod(F.torData, 0o700) // Tor refuse un dossier de données lisible par d'autres
  const share = path.join(path.dirname(path.dirname(tor)), 'share', 'tor')
  const geo = existsSync(path.join(share, 'geoip')) ? [`GeoIPFile ${quote(path.join(share, 'geoip'))}`, `GeoIPv6File ${quote(path.join(share, 'geoip6'))}`] : []
  const torrc = [
    '# Généré par Lumen VPN (vpn/vpn.ts) — réécrit à chaque démarrage',
    `SocksPort 127.0.0.1:${SOCKS_PORT}`,
    `ControlPort 127.0.0.1:${CONTROL_PORT}`,
    'CookieAuthentication 1',
    `DataDirectory ${quote(F.torData)}`,
    // Journal sur la sortie standard, redirigée vers tor.log : « Log notice file » ne gère pas les chemins entre
    // guillemets, et on garde aussi les erreurs écrites avant que le journal soit ouvert.
    'Log notice stdout',
    ...geo,
    ...(country ? [`ExitNodes {${country}}`, 'StrictNodes 1'] : []),
  ]
  const excl = await excludeSpec(await readExcluded())
  if (excl) torrc.push(`ExcludeExitNodes ${excl}`)
  await fs.writeFile(F.torrc, torrc.join('\n') + '\n', { mode: 0o600 })
  const log = openSync(F.torLog, 'w', 0o600)
  let p: ReturnType<typeof spawn>
  try {
    p = spawn(tor, ['-f', F.torrc], { detached: true, stdio: ['ignore', log, log] })
  } finally {
    closeSync(log)
  }
  p.on('error', () => {}) // binaire non exécutable… : signalé juste en dessous (pas de pid), sans faire tomber le serveur
  p.unref()
  if (!p.pid) throw new Error('Tor ne démarre pas (binaire introuvable ou non exécutable)')
  await notePid(p.pid)
  return p.pid
}
/** pid de Tor pour les gardes (ils le relisent à chaque seconde : une relance automatique ne les déclenche pas). */
async function notePid(pid: number) {
  await ensureDir()
  await fs.writeFile(F.torPid, String(pid), { mode: 0o600 })
}

async function torBootstrap(pid: number, timeoutMs = 120_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!alive(pid)) throw new Error(`Tor s'est arrêté :\n${await tail(F.torLog)}`)
    try {
      const [lines] = await torCtl(['GETINFO status/bootstrap-phase'])
      const pct = Number(/PROGRESS=(\d+)/.exec(lines.join(' '))?.[1] ?? 0)
      step(`Connexion au réseau Tor… ${pct} %`)
      if (pct >= 100) return
    } catch {
      /* port de contrôle pas encore ouvert */
    }
    await sleep(700)
  }
  throw new Error('Tor ne termine pas sa connexion (réseau ou pare-feu qui bloque Tor ?)')
}

/** Ferme les circuits ouverts : les connexions déjà établies (onglets, apps) basculent tout de suite elles aussi. */
async function closeCircuits() {
  const [lines] = await torCtl(['GETINFO circuit-status'])
  const ids = lines.map((l) => /^(\d+) (?:BUILT|EXTENDED|LAUNCHED)\b.*PURPOSE=GENERAL/.exec(l)?.[1]).filter((x): x is string => !!x)
  await Promise.allSettled(ids.map((id) => torCtl([`CLOSECIRCUIT ${id}`])))
}

/** Change le pays de sortie sans relancer Tor. */
async function torSetCountry(country: string) {
  await torCtl([country ? `SETCONF ExitNodes={${country}} StrictNodes=1` : 'RESETCONF ExitNodes StrictNodes', 'SIGNAL NEWNYM'])
  await closeCircuits()
}

// ——— Sorties mal localisées ———
// La base GeoIP de Tor (IPFire) et celles des sites (ipinfo, MaxMind…) ne sont pas toujours d'accord : une sortie que
// Tor classe aux États-Unis peut être vue aux Pays-Bas par les sites. Quand deux services le confirment, on écarte les
// sorties de sa plage /24 que Tor classe dans ce même pays (ExcludeExitNodes) — pas les autres : une même plage peut
// être à moitié « Pays-Bas » et à moitié « États-Unis » pour Tor. Exclusions gardées 30 jours (sorties-exclues.json).

/** « 192.0.2.0/24 » → pays vu par les sites (seen) et pays que Tor attribue à ces sorties (tor). */
type Excluded = Record<string, { seen: string; tor?: string; at: number }>
const EXCL_DAYS = 30
async function readExcluded(): Promise<Excluded> {
  try {
    const all = JSON.parse(await fs.readFile(F.excluded, 'utf8')) as Excluded
    return Object.fromEntries(Object.entries(all).filter(([cidr, e]) => /^\d+\.\d+\.\d+\.0\/24$/.test(cidr) && Date.now() - e.at < EXCL_DAYS * 86400_000))
  } catch {
    return {}
  }
}
const slash24 = (ip: string) => (/^(\d+\.\d+\.\d+)\.\d+$/.exec(ip)?.[1] ?? '') + '.0/24'
function isExcluded(r: { ip: string; country: string }, excluded: Excluded): boolean {
  const e = excluded[slash24(r.ip)]
  return !!e && (!e.tor || e.tor === r.country)
}
/** Valeur d'ExcludeExitNodes : les adresses exactes concernées si le consensus est là, sinon les plages /24. */
async function excludeSpec(excluded: Excluded): Promise<string> {
  if (!Object.keys(excluded).length) return ''
  const relays = await consensusExits()
  if (!relays) return Object.keys(excluded).join(',')
  return [...new Set(relays.filter((r) => isExcluded(r, excluded)).map((r) => r.ip))].join(',')
}

/** Deuxième avis sur le pays d'une adresse (par Tor, pour ne pas révéler l'adresse réelle aux services). */
async function confirmCountry(ip: string): Promise<string[]> {
  const curl = findBin('curl') ?? 'curl'
  const via = ['--socks5-hostname', `127.0.0.1:${SOCKS_PORT}`, '-s', '-m', '10']
  const [a, b] = await Promise.all([
    run(curl, [...via, `https://ipinfo.io/${ip}/country`], 13_000).then((r) => cleanCountry(r.stdout.trim())),
    run(curl, [...via, `https://api.ip.sb/geoip/${ip}`], 13_000).then((r) => {
      try {
        return cleanCountry((JSON.parse(r.stdout) as Json).country_code)
      } catch {
        return ''
      }
    }),
  ])
  return [a, b].filter(Boolean)
}

async function excludeExit(ip: string, seen: string, tor: string) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return
  const all = await readExcluded()
  all[slash24(ip)] = { seen, tor, at: Date.now() }
  await fs.writeFile(F.excluded, JSON.stringify(all, null, 1))
  const spec = (await excludeSpec(all)) || ip
  await torCtl([`SETCONF ExcludeExitNodes="${spec}"`])
  await closeCircuits()
}

/**
 * Attend que le trafic sorte bien par Tor, dans le pays demandé tel que les sites le voient, et rend la nouvelle
 * position. Abandon au bout d'environ 35 s.
 */
async function torVerify(country: string): Promise<Place> {
  const t0 = Date.now()
  let wrong: Place | null = null
  for (let i = 0; Date.now() - t0 < 30_000; i++) {
    step(i ? `Vérification de la position (essai ${i + 1})…` : 'Vérification de la nouvelle position…')
    const p = await whereAmI(true)
    if (!p) {
      await sleep(1000)
      continue
    }
    if (!country || !p.country || p.country === country) return p
    // Le premier service voit un autre pays : on demande un deuxième avis avant d'écarter cette sortie.
    const others = await confirmCountry(p.ip)
    if (!others.length) return p // pas de deuxième avis possible : on n'écarte pas une sortie sur une seule réponse
    if (others.includes(country)) return { ...p, country, countryName: countryName(country) }
    wrong = p
    step(`Sortie vue en ${p.countryName} par les sites : on en prend une autre…`)
    await excludeExit(p.ip, p.country, country)
  }
  if (wrong) throw new Error(`Les sorties Tor en ${countryName(country)} sont vues ailleurs par les sites (${wrong.countryName}) : essaie un autre pays`)
  throw new Error(country ? `Aucune sortie Tor ne répond en ${countryName(country)} pour le moment : essaie un autre pays` : 'Le trafic ne passe pas par Tor')
}

/** Refuse tout de suite un pays sans aucune sortie Tor (sinon on attendrait la fin de torVerify pour rien). */
async function torCheckCountry(country: string) {
  if (!country) return
  const exits = await torExits()
  if (exits && !exits.get(country)) throw httpError(400, `Tor n'a aucune sortie en ${countryName(country)} en ce moment : choisis un autre pays`)
}

// ——— Proxy système de macOS (moteur Tor, option « tout le Mac ») ———

function sh(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
/**
 * Lance une commande avec les droits administrateur : macOS affiche sa fenêtre, l'utilisateur tape lui-même son mot de
 * passe. Rend la sortie standard de la commande.
 */
async function asAdmin(shell: string, prompt: string): Promise<string> {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const r = await run('/usr/bin/osascript', ['-e', `do shell script "${esc(shell)}" with prompt "${esc(prompt)}" with administrator privileges`], 180_000)
  if (r.code !== 0) throw new Error(/-128|annul|cancel/i.test(r.stderr) ? 'Mot de passe administrateur annulé' : `Échec : ${r.stderr.trim()}`)
  return r.stdout.trim()
}

/** Tous les services réseau activés (pas seulement ceux branchés : un câble Ethernet branché plus tard est couvert aussi). */
function networkServices(): string[] {
  const out = spawnSync('/usr/sbin/networksetup', ['-listallnetworkservices'], { encoding: 'utf8' }).stdout ?? ''
  return out.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('*'))
}
function getSocks(service: string): ProxySetting {
  const o = spawnSync('/usr/sbin/networksetup', ['-getsocksfirewallproxy', service], { encoding: 'utf8' }).stdout ?? ''
  return { enabled: /^Enabled: Yes/m.test(o), server: /^Server: (.*)$/m.exec(o)?.[1].trim() ?? '', port: Number(/^Port: (\d+)/m.exec(o)?.[1] ?? 0), bypass: getBypass(service) }
}
/** Exceptions du proxy d'un service (« There aren't any bypass domains… » quand la liste est vide). */
function getBypass(service: string): string[] {
  const o = spawnSync('/usr/sbin/networksetup', ['-getproxybypassdomains', service], { encoding: 'utf8' }).stdout ?? ''
  return o.split('\n').map((l) => l.trim()).filter((l) => l && !/\s/.test(l))
}
const bypassCmd = (service: string, list: string[]) => ['-setproxybypassdomains', service, ...(list.length ? list : ['Empty'])]
/**
 * Applique des réglages networksetup. Sans droits suffisants : fenêtre de mot de passe si interactive, sinon erreur
 * (la surveillance automatique ne doit jamais faire surgir une fenêtre de mot de passe toute seule).
 */
async function networksetup(cmds: string[][], interactive: boolean) {
  let denied = false
  for (const c of cmds) {
    const r = spawnSync('/usr/sbin/networksetup', c, { encoding: 'utf8' })
    if (r.status !== 0 || /error|admin|root/i.test((r.stdout ?? '') + (r.stderr ?? ''))) {
      denied = true
      break
    }
  }
  if (!denied) return
  if (!interactive) throw new Error('modifier le proxy de macOS demande ici le mot de passe administrateur')
  await asAdmin(cmds.map((c) => ['/usr/sbin/networksetup', ...c].map(sh).join(' ')).join(' && '), 'Lumen VPN veut modifier le proxy réseau de ce Mac.')
}
function snapshotProxy(): Record<string, ProxySetting> {
  return Object.fromEntries(networkServices().map((s) => [s, getSocks(s)]))
}
/** Proxy SOCKS sur chaque service, avec Claude en exception (ajoutée aux exceptions déjà là). */
async function proxyOn(prev: Record<string, ProxySetting>) {
  await networksetup(
    Object.entries(prev).flatMap(([s, p]) => [
      bypassCmd(s, [...new Set([...(p.bypass ?? []), ...CLAUDE_DOMAINS])]),
      ['-setsocksfirewallproxy', s, '127.0.0.1', String(SOCKS_PORT)],
      ['-setsocksfirewallproxystate', s, 'on'],
    ]),
    true,
  )
}
/** Commandes networksetup qui remettent le proxy d'avant (exportée pour les tests). */
export function restoreCmds(prev: Record<string, ProxySetting>): string[][] {
  return Object.entries(prev).flatMap(([s, p]) => [
    ...(p.enabled && p.server && !(p.server === '127.0.0.1' && p.port === SOCKS_PORT)
      ? [['-setsocksfirewallproxy', s, p.server, String(p.port)], ['-setsocksfirewallproxystate', s, 'on']]
      : [['-setsocksfirewallproxystate', s, 'off']]),
    ...(p.bypass ? [bypassCmd(s, p.bypass)] : []), // ancien état sans liste notée : on n'y touche pas
  ])
}
async function proxyOff(prev: Record<string, ProxySetting>, interactive: boolean) {
  const cmds = restoreCmds(prev)
  if (cmds.length) await networksetup(cmds, interactive)
}

// ——— Gardes : rendre Internet même si la page, le serveur ou Tor s'arrêtent ———
// Scripts sh minuscules, détachés (ils survivent au serveur). Ils relisent tor.pid chaque seconde.

/** Vrai si le pid noté est un Tor vivant (sh). */
const SH_TOR_ALIVE = `p=$(/usr/bin/head -c 16 "$D/tor.pid" 2>/dev/null)
  case $p in ''|*[!0-9]*) up=0 ;; *) case $(/bin/ps -p "$p" -o comm= 2>/dev/null) in tor|*/tor) up=1 ;; *) up=0 ;; esac ;; esac`

/**
 * Garde du proxy (utilisateur). $1 = dossier, $2 = secondes de grâce. S'arrête sans rien faire quand
 * proxy-restaurer.sh disparaît (déconnexion normale) ; le lance si Tor est absent trop longtemps ou à SIGTERM
 * (extinction ou redémarrage du Mac : sans ça, le proxy resterait réglé sur un Tor mort au prochain démarrage).
 */
export const PROXY_GUARD = `D=$1; G=$2; R="$D/proxy-restaurer.sh"; m=0
fire() { trap '' TERM; [ -f "$R" ] && /bin/sh "$R" >/dev/null 2>&1; /bin/rm -f "$R"; exit 0; }
trap fire TERM
while [ -f "$R" ]; do
  ${SH_TOR_ALIVE}
  if [ "$up" = 1 ]; then m=0; else m=$((m+1)); fi
  [ "$m" -ge "$G" ] && fire
  /bin/sleep 1 & wait $!
done`

/**
 * Garde du pare-feu (root, lancé avec le mot de passe de l'activation). $1 = dossier, $2 = jeton pfctl -E,
 * $3 = délai de confirmation, $4 = secondes de grâce. Retire les règles : à la demande (pare-feu.retirer = son pid),
 * sans confirmation (pare-feu.ok = son pid) au bout de $3 s, ou si Tor est absent $4 s. Il ne fait rien d'autre :
 * les fichiers lus (écrits par l'utilisateur) ne peuvent que déclencher ce retrait.
 */
export function pfGuardScript(pfctl = '/sbin/pfctl'): string {
  return `D=$1; T=$2; C=$3; G=$4; PF=${sh(pfctl)}; n=0; m=0
mine() { [ -f "$1" ] && [ "$(/usr/bin/head -c 16 "$1" 2>/dev/null)" = "$$" ]; }
rel() { "$PF" -a ${PF_ANCHOR} -F all >/dev/null 2>&1; case $T in ''|*[!0-9]*) ;; *) "$PF" -X "$T" >/dev/null 2>&1 ;; esac; /bin/rm -f "$D/pare-feu.retirer"; exit 0; }
while :; do
  mine "$D/pare-feu.retirer" && rel
  [ "$n" -ge "$C" ] && ! mine "$D/pare-feu.ok" && rel
  ${SH_TOR_ALIVE}
  if [ "$up" = 1 ]; then m=0; else m=$((m+1)); fi
  [ "$m" -ge "$G" ] && rel
  n=$((n+1)); /bin/sleep 1
done`
}

/** Le garde (pid) tourne-t-il encore ? Vérifie aussi son nom : un pid recyclé par un autre programme ne compte pas. */
function guardAlive(pid: number | undefined, tag: string): boolean {
  if (!pid || !alive(pid)) return false
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
  const args = (r.stdout ?? '').trim()
  if (r.error) return true // ps en échec : on ne conclut pas à tort que le garde est parti
  if (!args) return false
  return args.includes(tag) || /^\(?(\/bin\/)?sh\)?$/.test(args) // arguments d'un processus root parfois masqués
}

async function startProxyGuard(prev: Record<string, ProxySetting>, torPid: number): Promise<number> {
  await notePid(torPid)
  const lines = restoreCmds(prev).map((c) => ['/usr/sbin/networksetup', ...c].map(sh).join(' '))
  await fs.writeFile(F.restore, `# Lumen VPN — remet le proxy de macOS comme avant (lancé par le garde si Tor s'arrête)\n${lines.join('\n')}\n`, { mode: 0o600 })
  const g = spawn('/bin/sh', ['-c', PROXY_GUARD, PROXY_GUARD_TAG, VPN_DIR, String(GUARD_GRACE_S)], { detached: true, stdio: 'ignore' })
  g.on('error', () => {})
  g.unref()
  return g.pid ?? 0
}
/** Arrêt normal : le garde ne doit plus rien remettre (sinon il déferait une connexion suivante). */
async function stopProxyGuard(s: VpnState) {
  await fs.rm(F.restore, { force: true }) // il sort de sa boucle tout seul…
  if (s.guard && guardAlive(s.guard, PROXY_GUARD_TAG)) {
    try {
      process.kill(s.guard, 'SIGKILL') // … et tout de suite (SIGKILL : pas de remise du proxy)
    } catch {
      /* déjà parti */
    }
  }
  delete s.guard
}

// ——— Pare-feu (pf de macOS) ———
// Avec « Tout le Mac », les navigateurs passent par Tor, mais WebRTC envoie de l'UDP en direct (Tor ne transporte pas
// l'UDP) : n'importe quel site peut ainsi lire la vraie adresse. Le pare-feu se charge dans l'ancre com.apple/lumen-vpn
// (prévue par /etc/pf.conf, qu'on ne modifie pas) le temps de la connexion :
//  - « fuites » : bloque tout l'UDP qui sort du Mac (WebRTC, QUIC, appels…), sauf DHCP, Bonjour et le DNS du système.
//    Les autres apps continuent de marcher en TCP.
//  - « total » (coupe-circuit) : seuls Tor (ses relais d'entrée), Claude, le DNS du système et le réseau local peuvent
//    sortir. Les apps qui ignorent le proxy de macOS (Mail, App Store…) sont coupées pendant la connexion.
// Claude est toujours permis : Claude Code (Node) ignore le proxy de macOS, sans cette exception le coupe-circuit
// coupait la conversation (vécu le 2026-11-24 : Wi-Fi connecté, plus d'Internet, plus moyen de parler à Claude).
// pfctl -E / -X : activation avec jeton, qui laisse pf tel qu'il était à la fin. Charger les règles demande le mot de
// passe administrateur (fenêtre de macOS) ; le garde root lancé dans la foulée les retire ensuite sans mot de passe.
// Les règles disparaissent aussi au redémarrage du Mac.

export type FirewallMode = 'fuites' | 'total'
/** guard : pid du garde root (absent dans les états d'avant les gardes : retrait par mot de passe). */
type Firewall = { mode: FirewallMode; token: string; guard?: number }
const PF_ANCHOR = 'com.apple/lumen-vpn'
const isIp = (ip: string) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip) || (ip.includes(':') && /^[0-9a-f:]{2,39}$/i.test(ip))
/** Adresse seule ou plage (CIDR). */
const isNet = (n: string) => {
  const [ip, bits, extra] = n.split('/')
  if (extra !== undefined || !isIp(ip)) return false
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (ip.includes(':') ? 128 : 32))
}

/** Règles pf du pare-feu (exportée pour les tests). Les adresses non valides sont ignorées. allow : Claude. */
export function firewallRules(mode: FirewallMode, o: { dns?: string[]; guards?: string[]; allow?: string[] } = {}): string {
  const dns = [...new Set((o.dns ?? []).filter(isIp))]
  const guards = [...new Set((o.guards ?? []).filter(isIp))]
  const allow = [...new Set((o.allow ?? []).filter(isNet))]
  const r = [
    `# Lumen VPN — pare-feu « ${mode} » (ancre ${PF_ANCHOR}), chargé pendant la connexion, retiré à la déconnexion`,
    'pass out quick on lo0 all', // Tor, Ollama, Lumen… sur cette machine
    'pass out quick inet proto udp from any port 68 to any port 67', // DHCP (obtenir une adresse sur le Wi-Fi)
    'pass out quick inet6 proto udp from any port 546 to any port 547', // DHCPv6
    'pass out quick inet proto udp to 224.0.0.251 port 5353', // Bonjour (réseau local)
    'pass out quick inet6 proto udp to ff02::fb port 5353',
  ]
  if (allow.length) r.push(`pass out quick to { ${allow.join(', ')} }`) // Claude : la conversation ne se coupe jamais
  if (mode === 'fuites') {
    if (dns.length) r.push(`pass out quick proto udp to { ${dns.join(', ')} } port 53`) // DNS des apps hors proxy
    r.push('block return out quick proto udp all') // « return » : l'app est prévenue tout de suite et passe en TCP
  } else {
    if (!guards.length) throw new Error('relais d’entrée de Tor inconnus : coupe-circuit impossible sans eux')
    if (dns.length) r.push(`pass out quick proto { tcp, udp } to { ${dns.join(', ')} } port 53`) // pour joindre Claude
    r.push(
      `pass out quick proto tcp to { ${guards.join(', ')} }`, // relais d'entrée de Tor
      'pass out quick inet to { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 224.0.0.0/4 }', // réseau local
      'pass out quick inet6 to { fe80::/10, fc00::/7, ff00::/8 }',
      'pass out quick inet6 proto icmp6 all', // découverte des voisins IPv6
      'block return out quick all',
    )
  }
  return r.join('\n') + '\n'
}

/** Adresses de Claude : plages publiées d'Anthropic + noms résolus maintenant (au cas où ils changeraient). */
async function claudeNets(): Promise<string[]> {
  const found = await Promise.allSettled(CLAUDE_HOSTS.map((h) => Promise.race([lookup(h, { all: true }), sleep(4000).then(() => [])])))
  const ips = found.flatMap((f) => (f.status === 'fulfilled' ? f.value.map((a) => a.address) : []))
  return [...new Set([...ANTHROPIC_NETS, ...ips.filter(isIp)])]
}
/** Claude répond-il en direct (sans proxy) ? N'importe quel code HTTP suffit : la connexion passe. */
async function claudeReachable(): Promise<boolean> {
  const r = await run(findBin('curl') ?? 'curl', ['-s', '-o', '/dev/null', '-m', '8', '--noproxy', '*', '-w', '%{http_code}', 'https://api.anthropic.com/'], 12_000)
  return /^[1-5]\d\d$/.test(r.stdout.trim())
}

/** Serveurs DNS du système (scutil --dns). */
function dnsServers(): string[] {
  const out = spawnSync('/usr/sbin/scutil', ['--dns'], { encoding: 'utf8' }).stdout ?? ''
  return [...new Set([...out.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)].map((m) => m[1]).filter(isIp))]
}

/** Adresses des relais d'entrée de Tor (gardes) : les seules que le coupe-circuit laisse joindre en direct. */
async function torGuardIps(): Promise<string[]> {
  const [guards, conns] = await torCtl(['GETINFO entry-guards', 'GETINFO orconn-status'])
  const fps = new Set([...guards, ...conns].flatMap((l) => [...l.matchAll(/\$([0-9A-F]{40})/g)].map((m) => m[1])))
  const ips = new Set<string>()
  const answers = await Promise.allSettled([...fps].map((fp) => torCtl([`GETINFO ns/id/${fp}`])))
  for (const a of answers) {
    if (a.status !== 'fulfilled') continue
    for (const line of a.value[0] ?? []) {
      const v4 = /^r \S+ \S+ (?:\S+ )?\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (\d+\.\d+\.\d+\.\d+) /.exec(line)?.[1]
      const v6 = /^a \[([0-9a-f:]+)\]:\d+/i.exec(line)?.[1]
      for (const ip of [v4, v6]) if (ip && isIp(ip)) ips.add(ip)
    }
  }
  return [...ips]
}

async function firewallOn(mode: FirewallMode): Promise<Firewall> {
  if (!isMac) throw new Error('Le pare-feu n’est prévu que pour macOS')
  const rules = firewallRules(mode, { dns: dnsServers(), allow: await claudeNets(), ...(mode === 'total' ? { guards: await torGuardIps() } : {}) })
  // Vérification de la syntaxe sans droits (pfctl -n) avant de demander le mot de passe
  await ensureDir()
  const check = path.join(VPN_DIR, 'pare-feu.conf')
  await fs.writeFile(check, rules, { mode: 0o600 })
  const r = await run('/sbin/pfctl', ['-a', PF_ANCHOR, '-n', '-f', check], 15_000)
  if (r.code !== 0) throw new Error(`Règles du pare-feu refusées par pf : ${r.stderr.split('\n').filter((l) => /error|:\d+:/.test(l)).join(' ').slice(0, 200)}`)
  const b64 = Buffer.from(rules).toString('base64') // écrit par root dans un fichier à lui : rien ne peut le modifier entre-temps
  // Le garde passe en base64 dans la commande root : aucun fichier modifiable par l'utilisateur n'est exécuté en root.
  const guardB64 = Buffer.from(pfGuardScript()).toString('base64')
  await fs.rm(F.fwOk, { force: true })
  await fs.rm(F.fwRelease, { force: true })
  const script = [
    'f=$(/usr/bin/mktemp /private/var/tmp/lumen-pf.XXXXXX)',
    `/bin/echo ${b64} | /usr/bin/base64 -D > "$f"`,
    `/sbin/pfctl -a ${PF_ANCHOR} -f "$f" 2>/dev/null || { /bin/rm -f "$f"; exit 1; }`,
    '/bin/rm -f "$f"',
    `t=$(/sbin/pfctl -E 2>&1 | /usr/bin/awk '/[Tt]oken/{print $NF}')`,
    `g=$(/bin/echo ${guardB64} | /usr/bin/base64 -D)`,
    `/usr/bin/nohup /bin/sh -c "$g" ${PF_GUARD_TAG} ${sh(VPN_DIR)} "$t" ${FW_CONFIRM_S} ${GUARD_GRACE_S} </dev/null >/dev/null 2>&1 & echo "jeton=$t garde=$!"`,
  ].join('; ')
  const out = await asAdmin(script, mode === 'total' ? 'Lumen VPN veut activer son coupe-circuit (pare-feu).' : 'Lumen VPN veut activer son pare-feu anti-fuite.')
  return { mode, token: /jeton=(\d+)/.exec(out)?.[1] ?? '', guard: Number(/garde=(\d+)/.exec(out)?.[1] ?? 0) || undefined }
}

/** La vérification qui suit l'activation a réussi : le garde garde les règles (sinon il les retire au bout de 90 s). */
async function firewallConfirm(fw: Firewall) {
  if (fw.guard) await fs.writeFile(F.fwOk, String(fw.guard), { mode: 0o600 })
}

/**
 * Retire le pare-feu. Par le garde root (sans mot de passe) s'il tourne ; s'il est déjà parti, les règles sont déjà
 * retirées (il ne s'arrête qu'après les avoir retirées). Mot de passe seulement pour un pare-feu sans garde.
 */
async function firewallOff(fw: Firewall, interactive: boolean) {
  if (fw.guard) {
    if (guardAlive(fw.guard, PF_GUARD_TAG)) {
      await ensureDir()
      await fs.writeFile(F.fwRelease, String(fw.guard), { mode: 0o600 })
      const t0 = Date.now()
      while (guardAlive(fw.guard, PF_GUARD_TAG) && Date.now() - t0 < 8000) await sleep(250)
    }
    if (!guardAlive(fw.guard, PF_GUARD_TAG)) {
      await fs.rm(F.fwOk, { force: true })
      await fs.rm(F.fwRelease, { force: true })
      return
    }
  }
  if (!interactive) throw new Error('retirer le pare-feu demande le mot de passe administrateur')
  const token = /^\d+$/.test(fw.token) ? fw.token : ''
  const kill = fw.guard ? `/bin/kill ${Number(fw.guard)} 2>/dev/null; ` : ''
  await asAdmin(`${kill}/sbin/pfctl -a ${PF_ANCHOR} -F all 2>/dev/null; ${token ? `/sbin/pfctl -X ${token} 2>/dev/null; ` : ''}true`, 'Lumen VPN veut retirer son pare-feu.')
}

// ——— VPN Gate (OpenVPN) ———
// Sécurité : OpenVPN tourne en root avec une config venue d'un serveur bénévole inconnu. On ne garde que des directives
// sans danger (liste blanche : pas de script, plugin, fichier, réglage d'environnement…), on force script-security 1,
// et c'est root qui écrit config, mot de passe de gestion, journal et pid dans un dossier à lui (mktemp) : un autre
// programme ne peut ni modifier la config entre l'écriture et le lancement, ni détourner le journal par un lien.

type GateServer = { host: string; ip: string; score: number; ping: number; speed: number; country: string; sessions: number; config: string }
const badGate = new Set<string>() // serveurs qui ont échoué pendant cette session : on passe au suivant
/** Emplacements fixes seulement (pas le PATH) : ce binaire est lancé en root. */
const OPENVPN_PATHS = ['/opt/homebrew/sbin/openvpn', '/usr/local/sbin/openvpn', '/opt/local/sbin/openvpn']
const openvpnBin = () => OPENVPN_PATHS.find((p) => existsSync(p)) ?? null
const GATE_DIR_RE = /^\/private\/var\/tmp\/lumen-vpn\.[A-Za-z0-9]+$/

const OVPN_ALLOWED = new Set([
  'client', 'dev', 'proto', 'remote', 'cipher', 'data-ciphers', 'data-ciphers-fallback', 'auth', 'resolv-retry', 'nobind',
  'persist-key', 'persist-tun', 'verb', 'remote-cert-tls', 'tls-client', 'key-direction', 'ping', 'ping-restart', 'float',
  'reneg-sec', 'mute-replay-warnings', 'connect-retry', 'tun-mtu', 'mssfix', 'tls-version-min', 'auth-nocache',
  'explicit-exit-notify', 'hand-window', 'server-poll-timeout', 'keepalive',
])
const OVPN_BLOCKS = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'extra-certs'])
/** Ne garde d'une config OpenVPN que les directives de la liste blanche et les blocs de certificats. */
export function sanitizeOvpn(conf: string): string {
  const out: string[] = []
  let block: string | null = null
  let keep = false
  for (const raw of conf.split(/\r?\n/)) {
    const line = raw.trim()
    if (block) {
      if (line === `</${block}>`) block = null
      if (keep) out.push(line) // contenu d'un certificat : du texte PEM, jamais interprété comme directive
      continue
    }
    const open = /^<([a-z-]+)>$/i.exec(line)
    if (open) {
      block = open[1].toLowerCase()
      keep = OVPN_BLOCKS.has(block)
      if (keep) out.push(line)
      continue
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const [name, ...args] = line.split(/\s+/)
    if (!OVPN_ALLOWED.has(name)) continue
    if (name === 'dev' && args[0] !== 'tun') continue
    if (name === 'proto' && !/^(tcp|udp)[46]?(-client)?$/.test(args[0] ?? '')) continue
    if (name === 'remote' && !(/^[a-z0-9.:-]+$/i.test(args[0] ?? '') && (!args[1] || /^\d+$/.test(args[1])))) continue
    out.push(line)
  }
  return out.join('\n')
}

async function gateServers(): Promise<GateServer[]> {
  let csv = ''
  try {
    if (Date.now() - (await fs.stat(F.gateList)).mtimeMs < 20 * 60_000) csv = await fs.readFile(F.gateList, 'utf8')
  } catch {
    /* pas encore en cache */
  }
  if (!csv) {
    const r = await fetch('https://www.vpngate.net/api/iphone/', { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`Liste VPN Gate injoignable (HTTP ${r.status})`)
    csv = await r.text()
    await ensureDir()
    await fs.writeFile(F.gateList, csv)
  }
  return csv
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('*') && !l.startsWith('#'))
    .map((l) => l.split(','))
    .filter((c) => c.length >= 15 && /^[A-Z]{2}$/.test(c[6]) && c.at(-1))
    .map((c) => ({ host: c[0], ip: c[1], score: +c[2], ping: +c[3], speed: +c[4], country: c[6].toLowerCase(), sessions: +c[7], config: c.at(-1)! }))
}

/** Commande à l'interface de gestion d'OpenVPN (protégée par le mot de passe aléatoire de ~/.lumen/vpn/gestion.pw). */
async function mgmt(cmd: string): Promise<string> {
  const pw = (await fs.readFile(F.mgmtPw, 'utf8')).trim()
  return new Promise((resolve, reject) => {
    const sock = net.connect(MGMT_PORT, '127.0.0.1')
    let buf = ''
    let stage = 0 // 0 : attend la demande de mot de passe · 1 : attend la validation · 2 : attend la réponse
    const t = setTimeout(() => {
      sock.destroy()
      reject(new Error('OpenVPN ne répond pas'))
    }, 8000)
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      if (stage === 0 && buf.includes('ENTER PASSWORD:')) {
        stage = 1
        buf = ''
        sock.write(pw + '\n')
      } else if (stage === 1 && buf.includes('SUCCESS: password is correct')) {
        stage = 2
        buf = ''
        sock.write(cmd + '\n')
      } else if (stage === 1 && buf.includes('ERROR')) {
        clearTimeout(t)
        sock.destroy()
        reject(new Error('Interface de gestion OpenVPN : mot de passe refusé'))
      } else if (stage === 2) {
        const lines = buf.split(/\r?\n/).filter((l) => l && !l.startsWith('>'))
        if (lines.some((l) => /^(SUCCESS|ERROR):/.test(l) || l === 'END')) {
          clearTimeout(t)
          sock.end('quit\n')
          resolve(lines.join('\n'))
        }
      }
    })
    sock.on('close', () => {
      clearTimeout(t)
      reject(new Error('OpenVPN a fermé la connexion de gestion')) // sans effet si la réponse est déjà arrivée
    })
    sock.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

const gatePid = async (dir?: string) => (dir && GATE_DIR_RE.test(dir) ? Number((await fs.readFile(`${dir}/pid`, 'utf8').catch(() => '0')).trim()) || 0 : 0)
const gateLog = (dir?: string) => (dir && GATE_DIR_RE.test(dir) ? `${dir}/log` : '')

/** Lance OpenVPN (fenêtre de mot de passe de macOS) et rend tout de suite de quoi l'arrêter, avant même qu'il soit connecté. */
async function launchGate(country: string): Promise<{ pid: number; server: string; country: string; dir: string }> {
  if (!isMac) throw new Error('Le moteur VPN Gate n’est prévu que pour macOS pour le moment')
  const openvpn = openvpnBin()
  if (!openvpn) throw new Error("OpenVPN n'est pas installé (brew install openvpn)")
  if (await portBusy(MGMT_PORT)) throw new Error(`Le port ${MGMT_PORT} est déjà utilisé par un autre programme`)
  const list = (await gateServers()).filter((s) => (!country || s.country === country) && !badGate.has(s.host)).sort((a, b) => b.score - a.score)
  if (!list.length) throw new Error(`Aucun serveur VPN Gate disponible pour ${countryName(country)} en ce moment`)
  const srv = list[0]
  const conf = sanitizeOvpn(Buffer.from(srv.config, 'base64').toString('utf8'))
  if (!/^remote\s/m.test(conf) || !conf.includes('<ca>')) {
    badGate.add(srv.host)
    throw new Error(`Config du serveur ${srv.host} invalide : réessaie, Lumen VPN prendra le suivant`)
  }
  const full = conf + '\n' + ['redirect-gateway def1', 'connect-retry-max 2', 'script-security 1'].join('\n') + '\n'
  const pw = randomBytes(18).toString('hex')
  await ensureDir()
  await fs.writeFile(F.mgmtPw, pw + '\n', { mode: 0o600 })
  const b64 = Buffer.from(full).toString('base64') // seulement [A-Za-z0-9+/=] : sans danger dans la commande
  const script = [
    '/bin/rm -rf /private/var/tmp/lumen-vpn.*', // dossiers des connexions précédentes (déjà arrêtées)
    'd=$(/usr/bin/mktemp -d /private/var/tmp/lumen-vpn.XXXXXX)',
    '/bin/chmod 755 "$d"',
    'umask 077',
    `/bin/echo ${b64} | /usr/bin/base64 -D > "$d/c.ovpn"`,
    `/bin/echo ${pw} > "$d/pw"`,
    'umask 022',
    `${sh(openvpn)} --config "$d/c.ovpn" --script-security 1 --management 127.0.0.1 ${MGMT_PORT} "$d/pw" --daemon lumen-vpn --writepid "$d/pid" --log "$d/log"`,
    '/bin/echo "$d"',
  ].join(' && ')
  step('Mot de passe administrateur (fenêtre de macOS)…')
  const dir = (await asAdmin(script, `Lumen VPN veut se connecter en ${countryName(srv.country)} (VPN Gate).`)).split('\n').pop() ?? ''
  if (!GATE_DIR_RE.test(dir)) throw new Error(`Lancement d'OpenVPN inattendu : ${dir.slice(0, 120)}`)
  let pid = 0
  for (let i = 0; i < 15 && !pid; i++) {
    pid = await gatePid(dir)
    if (!pid) await sleep(200)
  }
  return { pid, server: srv.host, country: srv.country, dir }
}

/** Attend « Initialization Sequence Completed » ; en cas d'échec, le serveur est écarté pour la suite. */
async function waitGate(g: { server: string; country: string; dir: string }) {
  step(`Connexion au serveur ${g.server} (${countryName(g.country)})…`)
  const t0 = Date.now()
  while (Date.now() - t0 < 45_000) {
    const log = await fs.readFile(gateLog(g.dir), 'utf8').catch(() => '')
    if (log.includes('Initialization Sequence Completed')) return
    if (/AUTH_FAILED|Exiting due to fatal error|TLS handshake failed|Connection refused/.test(log)) break
    await sleep(800)
  }
  badGate.add(g.server)
  throw new Error(`Le serveur ${g.server} ne répond pas : réessaie, Lumen VPN prendra le suivant.\n${await tail(gateLog(g.dir), 3)}`)
}

/** Arrête OpenVPN par son interface de gestion ; en dernier recours (et seulement si interactif), kill en administrateur. */
async function stopGate(s: VpnState, interactive: boolean) {
  await mgmt('signal SIGTERM').catch(() => {})
  const p = s.pid || (await gatePid(s.dir))
  if (!p) return
  const t0 = Date.now()
  while (alive(p) && Date.now() - t0 < 8000) await sleep(250)
  if (!alive(p)) return
  if (!interactive) throw new Error('OpenVPN ne s’arrête pas tout seul')
  await asAdmin(`/bin/kill ${Number(p)}`, 'Lumen VPN veut arrêter la connexion VPN.')
}

// ——— Arrêt commun ———

/** Démarrage du Mac (ms depuis 1970), 0 si inconnu. */
function bootTime(): number {
  const out = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).stdout ?? ''
  return Number(/sec = (\d+)/.exec(out)?.[1] ?? 0) * 1000
}
/** Connexion d'avant le dernier démarrage du Mac : Tor, OpenVPN, les gardes et le pare-feu n'existent plus. */
const rebooted = (s: VpnState) => {
  const boot = bootTime()
  return boot > 0 && s.since < boot
}
/** Oublie ce que le redémarrage a déjà effacé (rien à arrêter, pas de mot de passe pour un pare-feu disparu). */
function forgetReboot(s: VpnState) {
  s.pid = 0
  s.restarts = 99
  delete s.dir // VPN Gate : le pid noté dans ce dossier est périmé
  delete s.firewall
  delete s.guard
}

/**
 * Met l'état d'accord avec les gardes qui ont déjà agi (garde parti = travail fait : le garde du proxy ne s'arrête
 * qu'après avoir remis le proxy, celui du pare-feu qu'après avoir retiré les règles). Rend ce qui a changé.
 */
function syncGuards(s: VpnState): string[] {
  const notes: string[] = []
  if (s.system && s.guard && !guardAlive(s.guard, PROXY_GUARD_TAG)) {
    s.system = false
    delete s.prevProxy
    delete s.guard
    notes.push('le proxy de macOS a été remis comme avant')
  }
  if (s.firewall?.guard && !guardAlive(s.firewall.guard, PF_GUARD_TAG)) {
    delete s.firewall
    notes.push('le pare-feu s’est retiré tout seul')
  }
  return notes
}

/** interactive = false pour la surveillance automatique : jamais de fenêtre de mot de passe, une erreur à la place. */
async function stopAll(s: VpnState, interactive: boolean) {
  if (s.engine === 'tor') {
    if (s.system && s.prevProxy) {
      await proxyOff(s.prevProxy, interactive) // d'abord le proxy : internet revient avant tout
      s.system = false // noté dans s : si la suite échoue, l'appelant garde un état exact
      delete s.prevProxy
    }
    await stopProxyGuard(s)
    if (running(s)) await killPid(s.pid)
    await fs.rm(F.torPid, { force: true })
  } else {
    await stopGate(s, interactive)
  }
  // Le pare-feu en dernier : tant qu'il est là, rien ne sort en clair pendant l'arrêt
  if (s.firewall) {
    await firewallOff(s.firewall, interactive)
    delete s.firewall
  }
}

// ——— API publique ———

/**
 * Se connecte, ou change de pays si déjà connecté. country = code ISO à 2 lettres, '' = au plus rapide.
 * renew : nouvelle adresse IP dans le même pays (Tor). system : proxy de tout le Mac (Tor, macOS).
 * firewall : pare-feu pf « fuites » ou « total » (Tor avec « tout le Mac » seulement ; mot de passe administrateur).
 */
export async function connect(o: { engine?: Engine; country?: string; system?: boolean; renew?: boolean; firewall?: 'off' | FirewallMode }): Promise<VpnStatus> {
  if (busy) throw httpError(409, `Patiente : ${busy}`)
  const engine: Engine = o.engine === 'vpngate' ? 'vpngate' : 'tor'
  const country = cleanCountry(o.country)
  if (o.country && (!country || !knownCountry(country))) throw httpError(400, `Code pays inconnu : « ${String(o.country).slice(0, 12)} » (exemples : fr, de, us)`)
  busy = 'Préparation…' // posé tout de suite (avant tout await) : un deuxième appel dans ce processus est refusé
  if (!(await takeLock('Préparation…'))) {
    busy = null
    throw httpError(409, `Patiente : ${(await otherBusy()) ?? 'une autre opération est en cours'}`)
  }
  lastError = null
  let fresh: VpnState | null = null
  let warning: string | null = null // connexion réussie, mais un réglage demandé a été défait par sécurité
  try {
    let s = await readState()
    if (s && rebooted(s)) forgetReboot(s)
    if (s && !running(s)) {
      await stopAll(s, true)
      await writeState(null)
      s = null
    }
    if (s) syncGuards(s) // un garde qui a déjà agi : son réglage sera refait plus bas si on le veut toujours
    if (s && s.engine !== engine) {
      step('Arrêt de la connexion précédente…')
      await stopAll(s, true)
      await writeState(null)
      s = null
    }
    if (engine === 'tor') {
      await torCheckCountry(country)
      if (s) {
        if (o.renew || s.country !== country) {
          const prev = s.country
          step(country === prev ? 'Nouvelle adresse IP…' : `Bascule vers ${countryName(country)}…`)
          await torSetCountry(country)
          try {
            s.place = await torVerify(country)
          } catch (e) {
            await torSetCountry(prev).catch(() => {}) // on revient au pays qui marchait
            throw e
          }
          s.country = country
          await writeState(s)
        }
      } else {
        step('Démarrage de Tor…')
        const pid = await startTor(country)
        s = fresh = { engine: 'tor', pid, country, system: false, since: Date.now() }
        await writeState(s)
        await torBootstrap(pid)
        s.place = await torVerify(country)
        await writeState(s)
      }
      const wantSystem = !!o.system && isMac
      if (wantSystem && !s.system) {
        step('Proxy système de macOS…')
        const prev = snapshotProxy()
        // Noté AVANT de toucher au réglage : si tout s'arrête brutalement ici, on saura encore le défaire.
        s.prevProxy = prev
        s.system = true
        // Garde lancé AVANT le proxy : quoi qu'il arrive ensuite (Tor, serveur, extinction du Mac), il remet le proxy.
        s.guard = await startProxyGuard(prev, s.pid)
        await writeState(s)
        try {
          await proxyOn(prev)
        } catch (e) {
          await proxyOff(prev, false).catch(() => {}) // défait ce qui a pu être appliqué
          await stopProxyGuard(s)
          s.system = false
          delete s.prevProxy
          await writeState(s)
          throw e
        }
      } else if (!wantSystem && s.system) {
        step('Retrait du proxy système…')
        if (s.prevProxy) await proxyOff(s.prevProxy, true)
        await stopProxyGuard(s)
        s.system = false
        delete s.prevProxy
        await writeState(s)
      }
      // Pare-feu : seulement avec « tout le Mac » (sans proxy système, le coupe-circuit couperait aussi les navigateurs)
      const wantFw = wantSystem && (o.firewall === 'fuites' || o.firewall === 'total') ? o.firewall : null
      if ((s.firewall?.mode ?? null) !== wantFw) {
        if (s.firewall) {
          step('Retrait du pare-feu…')
          await firewallOff(s.firewall, true)
          delete s.firewall
          await writeState(s)
        }
        if (wantFw) {
          const claudeBefore = await claudeReachable()
          step('Pare-feu : mot de passe administrateur (fenêtre de macOS)…')
          s.firewall = { mode: wantFw, token: '' } // noté avant : un arrêt brutal laissera de quoi le retirer
          await writeState(s)
          try {
            s.firewall = await firewallOn(wantFw)
          } catch (e) {
            delete s.firewall
            await writeState(s)
            throw e
          }
          await writeState(s)
          // Vérification : si le pare-feu coupe Claude ou Tor, il est retiré tout de suite (sans mot de passe, par
          // son garde). Si cette vérification n'aboutit pas (serveur arrêté…), le garde le retire seul au bout de 90 s.
          step('Pare-feu : vérification (Claude et Tor passent-ils ?)…')
          const [claudeAfter, place] = await Promise.all([claudeReachable(), whereAmI(true, 15)])
          const cut = claudeBefore && !claudeAfter ? 'Claude' : !place ? 'Tor' : ''
          if (cut) {
            await firewallOff(s.firewall, true).catch(() => {}) // garde parti en vrac : il retire tout seul à 90 s
            delete s.firewall
            await writeState(s)
            warning = `Pare-feu retiré aussitôt : il coupait ${cut}. Le VPN reste actif sans pare-feu.`
          } else {
            await firewallConfirm(s.firewall)
            s.place = place
            await writeState(s)
          }
        }
      }
      fresh = null
    } else {
      step('Liste des serveurs VPN Gate…')
      const before = await realPlace()
      if (s) {
        step('Arrêt du serveur précédent…')
        await stopGate(s, true)
        await writeState(null)
        s = null
      }
      const g = await launchGate(country)
      // Noté tout de suite : même si tout s'arrête pendant l'attente, on pourra encore arrêter OpenVPN.
      s = fresh = { engine: 'vpngate', pid: g.pid, country: g.country, system: true, since: Date.now(), server: g.server, dir: g.dir, before }
      await writeState(s)
      await waitGate(g)
      step('Vérification de la nouvelle position…')
      s.place = await whereAmI(false)
      fresh = null
      await writeState(s)
    }
  } catch (e) {
    lastError = (e as Error).message
    if (fresh) {
      try {
        await stopAll(fresh, true)
        await writeState(null)
      } catch {
        /* état gardé : « Déconnecter » pourra réessayer */
      }
    }
    throw e
  } finally {
    busy = null
    await dropLock()
  }
  if (warning) lastError = warning
  return status()
}

export async function disconnect(): Promise<VpnStatus> {
  if (busy) throw httpError(409, `Patiente : ${busy}`)
  busy = 'Déconnexion…'
  if (!(await takeLock('Déconnexion…'))) {
    busy = null
    throw httpError(409, `Patiente : ${(await otherBusy()) ?? 'une autre opération est en cours'}`)
  }
  lastError = null
  try {
    const s = await readState()
    if (s) await stopAll(s, true) // si ça échoue, l'état reste : on pourra réessayer
    await writeState(null)
  } catch (e) {
    lastError = (e as Error).message
    throw e
  } finally {
    busy = null
    await dropLock()
  }
  return status()
}

/** État courant. refresh : revérifie la position publique (quelques secondes). */
export async function status(opts: { refresh?: boolean } = {}): Promise<VpnStatus> {
  const other = busy ? null : await otherBusy()
  let s = await readState()
  const stale = (x: VpnState) => rebooted(x) || !running(x) || (x.system && !!x.guard && !guardAlive(x.guard, PROXY_GUARD_TAG)) || (!!x.firewall?.guard && !guardAlive(x.firewall.guard, PF_GUARD_TAG))
  if (s && !busy && !other && stale(s) && (await takeLock('Nettoyage…'))) {
    // Le moteur s'est arrêté, le Mac a redémarré ou un garde a agi : on remet tout d'accord, Internet d'abord.
    try {
      const again = await readState() // relu sous verrou : un autre processus a pu changer les choses entre-temps
      const notes: string[] = []
      const wasRebooted = !!again && rebooted(again)
      if (again && wasRebooted) forgetReboot(again)
      if (again) notes.push(...syncGuards(again))
      if (again && again.engine === 'tor' && !running(again) && (again.restarts ?? 0) < 3 && !notes.length) {
        // Tor s'est arrêté : on le relance dans le même pays. Le proxy de macOS reste en place, donc rien ne sort en
        // clair pendant la relance (les navigateurs attendent quelques secondes). Le garde du proxy (15 s de grâce)
        // voit le nouveau pid et ne fait rien. Pas de relance si le garde a déjà remis le proxy.
        busy = 'Tor s’est arrêté : relance automatique…'
        try {
          again.restarts = (again.restarts ?? 0) + 1
          again.pid = await startTor(again.country)
          await writeState(again)
          await torBootstrap(again.pid, 60_000)
          lastError = null
        } catch {
          // relance ratée : on arrête ce Tor qui ne se connecte pas (sinon les gardes le croiraient en état de marche)
          if (running(again)) await killPid(again.pid)
        } finally {
          busy = null
        }
      }
      if (again && !running(again)) {
        const why = again.engine === 'tor' && !wasRebooted ? (await tail(F.torLog, 30)).split('\n').filter((l) => /\[(err|warn)\]/.test(l)).pop()?.replace(/^.*?\[(err|warn)\]\s*/, '') : ''
        const what = wasRebooted ? 'Le Mac a redémarré : connexion terminée' : again.engine === 'tor' ? 'Tor s’est arrêté de façon inattendue' : 'La connexion VPN Gate s’est coupée'
        const hadProxy = again.engine === 'tor' && (again.system || notes.some((n) => n.includes('proxy')))
        try {
          await stopAll(again, false)
          await writeState(null)
          lastError = what + (hadProxy ? ' ; le proxy de macOS a été remis comme avant.' : '.') + (why ? ` (${why})` : '')
          s = null
        } catch (e) {
          // Impossible de tout défaire sans mot de passe : l'état (à jour de ce qui a été défait) reste, et
          // « Déconnecter » finira le travail avec la fenêtre de macOS.
          await writeState(again)
          lastError = `${what}, et ${(e as Error).message}. Clique sur Déconnecter pour tout remettre en ordre.`
          s = again
        }
      } else {
        if (again && notes.length) {
          await writeState(again)
          lastError = `Par sécurité, ${notes.join(' et ')}.`
        }
        s = again
      }
    } finally {
      await dropLock()
    }
  }
  const up = running(s)
  if (up && opts.refresh && !busy && !other) {
    const place = await whereAmI(s!.engine === 'tor')
    const cur = await readState() // pendant la vérification, une déconnexion a pu avoir lieu : ne pas la défaire
    if (place && cur && cur.pid === s!.pid && cur.since === s!.since) {
      cur.place = place
      await writeState(cur)
      s = cur
    }
  }
  const shownBusy = busy ?? other
  return {
    connected: up && !shownBusy,
    engine: s?.engine ?? null,
    country: s ? s.country : null,
    countryName: s ? countryName(s.country) : null,
    system: !!s?.system,
    firewall: s?.firewall?.mode ?? null,
    since: s?.since ?? null,
    server: s?.server ?? null,
    place: s?.place ?? null,
    socks: up && s?.engine === 'tor' ? `socks5h://127.0.0.1:${SOCKS_PORT}` : null,
    busy: shownBusy,
    error: lastError,
    available: { tor: !!findBin('tor'), vpngate: isMac && !!openvpnBin(), system: isMac },
  }
}

/** Pays proposés : sorties Tor (consensus local, sinon Onionoo en cache 6 h) ou serveurs VPN Gate du moment (cache 20 min). */
export async function countries(engine: Engine): Promise<Country[]> {
  const byName = (a: Country, b: Country) => a.name.localeCompare(b.name, 'fr')
  if (engine === 'vpngate') {
    const m = new Map<string, Country>()
    for (const s of await gateServers()) {
      const c = m.get(s.country) ?? { code: s.country, name: countryName(s.country), servers: 0, weight: 0 }
      c.servers++
      c.weight = Math.max(c.weight, s.score)
      m.set(s.country, c)
    }
    return [...m.values()].sort(byName)
  }
  // 1) Données de Tor (exactes pour ExitNodes) dès qu'il a tourné une fois ; 2) Onionoo ; 3) liste de repli.
  const local = await torExits().catch(() => null)
  if (local?.size) return [...local.values()].sort(byName)
  try {
    if (Date.now() - (await fs.stat(F.torCountries)).mtimeMs < 6 * 3600_000) return JSON.parse(await fs.readFile(F.torCountries, 'utf8')) as Country[]
  } catch {
    /* pas encore en cache */
  }
  try {
    const url = 'https://onionoo.torproject.org/details?search=flag:exit%20running:true&fields=country,exit_probability'
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as { relays: { country?: string; exit_probability?: number }[] }
    const m = new Map<string, Country>()
    for (const relay of data.relays) {
      const code = cleanCountry(relay.country)
      if (!code || code === 'eu') continue
      const c = m.get(code) ?? { code, name: countryName(code), servers: 0, weight: 0 }
      c.servers++
      c.weight += relay.exit_probability ?? 0
      m.set(code, c)
    }
    const list = [...m.values()].sort(byName)
    await ensureDir()
    await fs.writeFile(F.torCountries, JSON.stringify(list))
    return list
  } catch {
    return TOR_FALLBACK.map((code) => ({ code, name: countryName(code), servers: 0, weight: 0 })).sort(byName)
  }
}
