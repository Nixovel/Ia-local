// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Lumen VPN — page locale et ligne de commande (module autonome, pas encore branché à Lumen).
 *   node vpn/app.ts                    → page sur http://127.0.0.1:5590
 *   node vpn/app.ts on de              → Tor, sortie en Allemagne, pour tout le Mac (navigateurs compris)
 *                                        --proxy-seul : seulement le proxy SOCKS 127.0.0.1:9450 · --nouvelle-ip
 *                                        --pare-feu : bloque les fuites WebRTC/UDP · --coupe-circuit : seul Tor peut sortir
 *                                        (pare-feu : mot de passe administrateur demandé par macOS)
 *   node vpn/app.ts on jp --vpngate    → vrai VPN par VPN Gate (mot de passe administrateur demandé par macOS)
 *   node vpn/app.ts off | statut | pays [tor|vpngate]
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { connect, countries, disconnect, realPlace, status, type Engine, type VpnStatus } from './vpn.ts'

const PORT = Number(process.env.LUMEN_VPN_PORT ?? 5590)
const HOST = '127.0.0.1'
const engineOf = (v: unknown): Engine => (v === 'vpngate' ? 'vpngate' : 'tor')

function describe(s: VpnStatus): string {
  if (!s.connected) return `Non connecté${s.error ? ` — ${s.error}` : ''}`
  const p = s.place
  const where = p ? [p.city, p.countryName].filter(Boolean).join(', ') : s.countryName
  const fw = s.firewall === 'total' ? ', coupe-circuit' : s.firewall === 'fuites' ? ', pare-feu anti-fuite' : ''
  const how = s.engine === 'tor' ? `Tor${s.system ? ', tout le Mac' : `, proxy ${s.socks}`}${fw}` : `VPN Gate (${s.server})`
  return `Connecté : ${where}${p ? ` · ${p.ip}` : ''} — ${how}`
}

async function cli(cmd: string, args: string[]) {
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const rest = args.filter((a) => !a.startsWith('--'))
  if (cmd === 'on') {
    const timer = setInterval(async () => {
      const s = await status()
      if (s.busy) process.stdout.write(`\r\x1b[K${s.busy}`)
    }, 700)
    try {
      const firewall = flags.has('--coupe-circuit') ? 'total' : flags.has('--pare-feu') ? 'fuites' : 'off'
      const s = await connect({ engine: flags.has('--vpngate') ? 'vpngate' : 'tor', country: rest[0] ?? '', system: !flags.has('--proxy-seul'), renew: flags.has('--nouvelle-ip'), firewall })
      process.stdout.write('\r\x1b[K')
      console.log(describe(s))
    } finally {
      clearInterval(timer)
    }
  } else if (cmd === 'off') console.log(describe(await disconnect()))
  else if (cmd === 'statut' || cmd === 'status') console.log(describe(await status({ refresh: true })))
  else if (cmd === 'pays') {
    for (const c of await countries(engineOf(rest[0]))) console.log(`${c.code}  ${c.name}${c.servers ? `  (${c.servers})` : ''}`)
  } else {
    console.log('Usage : node vpn/app.ts [on <pays> [--pare-feu|--coupe-circuit|--proxy-seul|--nouvelle-ip|--vpngate] | off | statut | pays [tor|vpngate]]')
    process.exitCode = 1
  }
}

function serve() {
  const send = (res: http.ServerResponse, code: number, body: string | Buffer, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(body)
  }
  const json = (res: http.ServerResponse, data: unknown, code = 200) => send(res, code, JSON.stringify(data))
  const tooBig = Object.assign(new Error('Requête trop grosse'), { status: 413 })
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let b = ''
      req.on('data', (d) => {
        b += d
        if (b.length > 10_000) {
          req.removeAllListeners('data')
          req.resume() // on laisse filer le reste sans le garder, puis on répond 413
          reject(tooBig)
        }
      })
      req.on('end', () => resolve(b))
      req.on('error', reject)
    })

  const server = http.createServer(async (req, res) => {
    // Seulement depuis cette machine, et pas depuis un autre site (DNS rebinding / requêtes forgées)
    const host = req.headers.host ?? ''
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, 'Interdit', 'text/plain; charset=utf-8')
    const url = new URL(req.url ?? '/', `http://${host}`)
    try {
      if (req.method === 'GET') {
        if (url.pathname === '/') return send(res, 200, await readFile(new URL('./ui.html', import.meta.url)), 'text/html; charset=utf-8')
        if (url.pathname === '/api/status') return json(res, await status({ refresh: url.searchParams.has('refresh') }))
        if (url.pathname === '/api/countries') return json(res, await countries(engineOf(url.searchParams.get('engine'))))
        if (url.pathname === '/api/real') return json(res, await realPlace())
      } else if (req.method === 'POST') {
        const origin = req.headers.origin
        if ((origin && origin !== `http://${host}`) || !String(req.headers['content-type']).startsWith('application/json')) return json(res, { error: 'Requête refusée' }, 403)
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown> | null
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, { error: 'Requête invalide (objet JSON attendu)' }, 400)
        if (url.pathname === '/api/connect') {
          const firewall = body.firewall === 'fuites' || body.firewall === 'total' ? body.firewall : 'off'
          return json(res, await connect({ engine: engineOf(body.engine), country: String(body.country ?? ''), system: body.system === true, renew: body.renew === true, firewall }))
        }
        if (url.pathname === '/api/disconnect') return json(res, await disconnect())
      }
      json(res, { error: 'Introuvable' }, 404)
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, { error: 'Requête invalide (JSON mal formé)' }, 400)
      json(res, { error: (e as Error).message }, (e as { status?: number }).status ?? 500)
    }
  })
  server.listen(PORT, HOST, () => console.log(`Lumen VPN : http://${HOST}:${PORT}`))
  // Surveillance : si Tor ou OpenVPN s'arrête tout seul, status() remet le proxy système d'avant.
  setInterval(() => status().catch(() => {}), 15_000).unref()
}

const [cmd, ...args] = process.argv.slice(2)
if (!cmd || cmd === 'serve') serve()
else {
  try {
    await cli(cmd, args)
  } catch (e) {
    process.stdout.write('\r\x1b[K')
    console.error(`Erreur : ${(e as Error).message}`)
    process.exitCode = 1
  }
}
