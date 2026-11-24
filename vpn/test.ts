// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Tests de Lumen VPN.
 *   node vpn/test.ts            → tests hors ligne (aucune connexion VPN, aucun réglage du Mac modifié)
 *   node vpn/test.ts --reseau   → + vraies connexions Tor en mode « proxy seul » (le proxy de macOS n'est jamais touché).
 *                                 Refusé si une connexion est déjà active, pour ne pas couper celle de l'utilisateur.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_DOMAINS, PROXY_GUARD, connect, countries, countryName, disconnect, firewallRules, ipCountry, pfGuardScript, restoreCmds, sanitizeOvpn, status, torExits } from './vpn.ts'

let ok = 0
let ko = 0
async function test(name: string, fn: () => Promise<void> | void) {
  const t = performance.now()
  try {
    await fn()
    ok++
    console.log(`  ✓ ${name} (${Math.round(performance.now() - t)} ms)`)
  } catch (e) {
    ko++
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`)
  }
}
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}
async function rejects(p: Promise<unknown>, re: RegExp, status?: number) {
  try {
    await p
  } catch (e) {
    check(re.test((e as Error).message), `message inattendu : ${(e as Error).message}`)
    if (status) check((e as { status?: number }).status === status, `code ${(e as { status?: number }).status} au lieu de ${status}`)
    return
  }
  throw new Error('aurait dû échouer')
}
const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => (s.destroy(), resolve(false)))
    s.once('error', () => resolve(true))
  })

console.log('Hors ligne')
await test('noms de pays en français', () => {
  check(countryName('de') === 'Allemagne' && countryName('us') === 'États-Unis' && countryName('') === 'Au plus rapide', 'noms faux')
})
await test('base GeoIP de Tor : adresses connues et invalides', async () => {
  check((await ipCountry('8.8.8.8')) === 'us', `8.8.8.8 → ${await ipCountry('8.8.8.8')}`)
  for (const bad of ['999.1.1.1', 'abc', '1.2.3', '', '10.0.0.0.1']) check((await ipCountry(bad)) === null, `${bad} devrait être inconnue`)
})
await test('carte des sorties Tor cohérente', async () => {
  const m = await torExits()
  if (!m) return console.log('      (pas encore de consensus : Tor n’a jamais tourné, test sauté)')
  const list = [...m.values()]
  check(list.length > 20, `${list.length} pays seulement`)
  check(list.every((c) => /^[a-z]{2}$/.test(c.code) && c.servers > 0), 'entrée invalide')
  const w = list.reduce((s, c) => s + c.weight, 0)
  check(Math.abs(w - 1) < 1e-6, `parts de bande passante : total ${w}`)
})
await test('liste des pays Tor triée en français', async () => {
  const cs = await countries('tor')
  check(cs.length > 20, `${cs.length} pays`)
  for (let i = 1; i < cs.length; i++) check(cs[i - 1].name.localeCompare(cs[i].name, 'fr') <= 0, `ordre : ${cs[i - 1].name} / ${cs[i].name}`)
})
await test('code pays inconnu refusé tout de suite (400)', () => rejects(connect({ country: 'zz' }), /Code pays inconnu/, 400))
await test('texte quelconque refusé (400)', () => rejects(connect({ country: 'France; rm -rf /' }), /Code pays inconnu/, 400))
await test('pays sans sortie Tor refusé tout de suite (400)', async () => {
  if (!(await torExits())) return
  await rejects(connect({ country: 'aq' }), /aucune sortie/, 400)
})
await test('config VPN Gate : directives dangereuses retirées', () => {
  const evil = [
    'client', 'dev tun', 'proto tcp', 'remote 192.0.2.1 443', 'cipher AES-128-CBC',
    'script-security 2', 'up "/bin/sh -c id"', 'down /tmp/x', 'plugin /tmp/evil.so', 'route-up /tmp/x', 'tls-verify /tmp/x',
    'setenv FOO bar', 'cd /', 'management 0.0.0.0 7505', 'log /etc/passwd', 'writepid /etc/x', 'config /tmp/other.conf',
    '<ca>', '-----BEGIN CERTIFICATE-----', 'MIIBup/bin/sh==', '-----END CERTIFICATE-----', '</ca>',
    '<connection>', 'remote 192.0.2.2 1194', 'up /tmp/x', '</connection>',
  ].join('\n')
  const out = sanitizeOvpn(evil)
  for (const bad of ['script-security 2', 'up ', 'down ', 'plugin', 'route-up', 'tls-verify', 'setenv', 'cd /', 'management', 'log /etc', 'writepid', 'config /tmp', '<connection>'])
    check(!out.split('\n').some((l) => l.trim().startsWith(bad)), `« ${bad} » conservé`)
  for (const good of ['client', 'dev tun', 'proto tcp', 'remote 192.0.2.1 443', 'cipher AES-128-CBC', '<ca>', '</ca>'])
    check(out.split('\n').includes(good), `« ${good} » perdu`)
  check(out.includes('-----BEGIN CERTIFICATE-----') && out.includes('MIIBup/bin/sh=='), 'contenu du certificat abîmé') // texte à l'intérieur de <ca> : intact
})
await test('config VPN Gate : interface tun et protocole imposés', () => {
  check(!sanitizeOvpn('dev tap\nproto tcp').includes('dev tap'), 'dev tap accepté')
  check(!sanitizeOvpn('proto icmp').includes('proto icmp'), 'proto inconnu accepté')
})

/** pfctl -n : vérifie la syntaxe sans rien charger (pas besoin d'être administrateur). */
function pfAccepts(rules: string): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lumen-pf-'))
  try {
    writeFileSync(path.join(dir, 'r.conf'), rules)
    return spawnSync('/sbin/pfctl', ['-a', 'com.apple/lumen-vpn', '-n', '-f', path.join(dir, 'r.conf')]).status === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
if (process.platform === 'darwin') {
  await test('pare-feu « fuites » : syntaxe acceptée par pf, UDP bloqué, DNS du système permis', () => {
    const r = firewallRules('fuites', { dns: ['192.0.2.53', '2001:db8::53'] })
    check(pfAccepts(r), 'pf refuse les règles')
    check(r.includes('pass out quick on lo0 all') && r.includes('block return out quick proto udp all'), 'règles de base absentes')
    check(r.includes('192.0.2.53') && r.includes('2001:db8::53'), 'DNS du système absent')
    check(r.indexOf('pass out quick on lo0') < r.indexOf('block return'), 'blocage avant les exceptions')
  })
  await test('pare-feu « total » : syntaxe acceptée, seuls les relais Tor et le réseau local passent', () => {
    const r = firewallRules('total', { guards: ['198.51.100.7', '2001:db8::7'] })
    check(pfAccepts(r), 'pf refuse les règles')
    check(r.includes('198.51.100.7') && r.trim().endsWith('block return out quick all'), 'blocage final absent')
  })
  await test('pare-feu : adresses piégées ignorées, coupe-circuit refusé sans relais', () => {
    const r = firewallRules('fuites', { dns: ['8.8.8.8 } pass out all {', '1.2.3.4; rm -rf /', '999.1.1.1', '8.8.4.4'] })
    check(!r.includes('rm -rf') && !r.includes('pass out all {') && !r.includes('999.1.1.1') && r.includes('8.8.4.4'), 'adresse piégée conservée')
    check(pfAccepts(r), 'pf refuse les règles filtrées')
    let threw = false
    try {
      firewallRules('total', { guards: ['pas une adresse'] })
    } catch {
      threw = true
    }
    check(threw, 'coupe-circuit accepté sans aucun relais')
  })
  await test('pare-feu : Claude toujours permis (les deux modes), DNS permis en « total »', () => {
    const allow = ['160.79.104.0/23', '2607:6bc0::/48', '160.79.104.10', '1.2.3.0/99', '8.8.8.8/8/8', 'claude.ai']
    for (const mode of ['fuites', 'total'] as const) {
      const r = firewallRules(mode, { dns: ['192.0.2.53'], guards: ['198.51.100.7'], allow })
      check(pfAccepts(r), `pf refuse les règles « ${mode} »`)
      const claude = r.indexOf('160.79.104.0/23')
      check(claude > 0 && claude < r.indexOf('block return'), `Claude absent ou après le blocage (« ${mode} »)`)
      check(r.includes('2607:6bc0::/48') && !r.includes('1.2.3.0/99') && !r.includes('8.8.8.8/8/8') && !r.includes('claude.ai'), 'plage invalide conservée')
    }
    const t = firewallRules('total', { dns: ['192.0.2.53'], guards: ['198.51.100.7'] })
    check(/pass out quick proto \{ tcp, udp \} to \{ 192\.0\.2\.53 \} port 53/.test(t), 'DNS bloqué en « total » : Claude ne serait plus joignable')
  })
}

console.log('Gardes (dossier temporaire, faux Tor, faux pfctl : rien n’est modifié sur le Mac)')
await test('remise du proxy : ancien service, exceptions remises telles quelles', () => {
  const c = restoreCmds({
    'Wi-Fi': { enabled: false, server: '127.0.0.1', port: 9450, bypass: ['*.local', '169.254/16'] },
    Ethernet: { enabled: true, server: '10.0.0.1', port: 1080, bypass: [] },
    Vieux: { enabled: true, server: '127.0.0.1', port: 9450 },
  }).map((x) => x.join(' '))
  check(c.includes('-setsocksfirewallproxystate Wi-Fi off') && c.includes('-setproxybypassdomains Wi-Fi *.local 169.254/16'), 'Wi-Fi mal remis')
  check(c.includes('-setsocksfirewallproxy Ethernet 10.0.0.1 1080') && c.includes('-setproxybypassdomains Ethernet Empty'), 'Ethernet mal remis')
  check(c.includes('-setsocksfirewallproxystate Vieux off') && !c.some((x) => x.includes('bypassdomains Vieux')), 'état ancien : exceptions touchées ou proxy Lumen gardé')
  check(CLAUDE_DOMAINS.includes('claude.ai') && CLAUDE_DOMAINS.includes('*.anthropic.com'), 'domaines de Claude absents')
})
await test('scripts des gardes : syntaxe sh valide', () => {
  for (const s of [PROXY_GUARD, pfGuardScript()]) check(spawnSync('/bin/sh', ['-n', '-c', s]).status === 0, 'erreur de syntaxe sh')
})
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lumen-garde-'))
  const isAlive = (pid?: number) => {
    try {
      return !!pid && (process.kill(pid, 0), true)
    } catch {
      return false
    }
  }
  const until = async (cond: () => boolean, ms: number) => {
    const t0 = Date.now()
    while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100))
    return cond()
  }
  const has = (f: string) => existsSync(path.join(dir, f))
  // Faux Tor : un lien « tor » vers sleep, comme le Tor de Homebrew (les gardes vérifient le nom du processus, pas
  // seulement le pid). Pas une copie : macOS tue aussitôt une copie d'un programme système (signature).
  symlinkSync('/bin/sleep', path.join(dir, 'tor'))
  const fakeTor = () => {
    const t = spawn(path.join(dir, 'tor'), ['600'], { stdio: 'ignore' })
    writeFileSync(path.join(dir, 'tor.pid'), String(t.pid))
    return t
  }
  const proxyGuard = () => {
    rmSync(path.join(dir, 'remis'), { force: true })
    writeFileSync(path.join(dir, 'proxy-restaurer.sh'), `echo ok > ${JSON.stringify(path.join(dir, 'remis'))}\n`)
    return spawn('/bin/sh', ['-c', PROXY_GUARD, 'lumen-vpn-garde', dir, '2'], { stdio: 'ignore' })
  }
  const pfctl = path.join(dir, 'pfctl')
  writeFileSync(pfctl, `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(dir, 'pf.log'))}\n`, { mode: 0o755 })
  const pfLog = () => (existsSync(path.join(dir, 'pf.log')) ? readFileSync(path.join(dir, 'pf.log'), 'utf8') : '')
  const pfGuard = (token: string, confirmS: number, graceS: number) => {
    rmSync(path.join(dir, 'pf.log'), { force: true })
    for (const f of ['pare-feu.ok', 'pare-feu.retirer']) rmSync(path.join(dir, f), { force: true })
    return spawn('/bin/sh', ['-c', pfGuardScript(pfctl), 'lumen-pf-garde', dir, token, String(confirmS), String(graceS)], { stdio: 'ignore' })
  }
  const kill = (...ps: { pid?: number; kill: (s?: NodeJS.Signals) => boolean }[]) => ps.forEach((p) => isAlive(p.pid) && p.kill('SIGKILL'))
  try {
    await test('garde du proxy : Tor vivant → rien ; Tor arrêté → proxy remis au bout de la grâce', async () => {
      const tor = fakeTor()
      const g = proxyGuard()
      try {
        await new Promise((r) => setTimeout(r, 3500))
        check(isAlive(g.pid) && !has('remis'), 'proxy remis alors que Tor tourne')
        tor.kill('SIGKILL')
        check(await until(() => has('remis'), 6000), 'proxy pas remis après l’arrêt de Tor')
        check(await until(() => !isAlive(g.pid), 2000) && !has('proxy-restaurer.sh'), 'garde toujours là après avoir agi')
      } finally {
        kill(tor, g)
      }
    })
    await test('garde du proxy : relance de Tor (nouveau pid) pendant la grâce → rien', async () => {
      const t1 = fakeTor()
      const g = proxyGuard()
      let t2: ReturnType<typeof fakeTor> | undefined
      try {
        await new Promise((r) => setTimeout(r, 1200))
        t1.kill('SIGKILL')
        await new Promise((r) => setTimeout(r, 800))
        t2 = fakeTor() // comme la relance automatique de status()
        await new Promise((r) => setTimeout(r, 3500))
        check(isAlive(g.pid) && !has('remis'), 'proxy remis alors que Tor a été relancé à temps')
      } finally {
        kill(t1, g, ...(t2 ? [t2] : []))
      }
    })
    await test('garde du proxy : déconnexion normale (fichier retiré) → s’arrête sans rien remettre', async () => {
      const tor = fakeTor()
      const g = proxyGuard()
      try {
        await new Promise((r) => setTimeout(r, 500))
        rmSync(path.join(dir, 'proxy-restaurer.sh'))
        check(await until(() => !isAlive(g.pid), 2500), 'garde toujours là')
        check(!has('remis'), 'proxy remis lors d’une déconnexion normale')
      } finally {
        kill(tor, g)
      }
    })
    await test('garde du proxy : extinction du Mac (SIGTERM) → proxy remis tout de suite', async () => {
      const tor = fakeTor()
      const g = proxyGuard()
      try {
        await new Promise((r) => setTimeout(r, 500))
        g.kill('SIGTERM')
        check(await until(() => has('remis'), 2000), 'proxy pas remis à SIGTERM')
      } finally {
        kill(tor, g)
      }
    })
    await test('garde du pare-feu : demande de retrait (son pid) → règles retirées, jeton rendu', async () => {
      const tor = fakeTor()
      const g = pfGuard('4242', 60, 10)
      try {
        await new Promise((r) => setTimeout(r, 500))
        writeFileSync(path.join(dir, 'pare-feu.retirer'), '999999') // pas son pid : ignoré
        await new Promise((r) => setTimeout(r, 1500))
        check(isAlive(g.pid) && !pfLog(), 'retrait demandé par un autre pid exécuté')
        writeFileSync(path.join(dir, 'pare-feu.retirer'), String(g.pid))
        check(await until(() => !isAlive(g.pid), 3000), 'garde toujours là')
        const log = pfLog()
        check(log.includes('-a com.apple/lumen-vpn -F all') && log.includes('-X 4242'), `pfctl : ${log.trim() || '(rien)'}`)
        check(!has('pare-feu.retirer'), 'demande de retrait pas effacée')
      } finally {
        kill(tor, g)
      }
    })
    await test('garde du pare-feu : pas de confirmation → retrait automatique ; jeton invalide jamais passé à pfctl', async () => {
      const tor = fakeTor()
      const g = pfGuard('12; rm -rf /', 2, 10)
      try {
        check(await until(() => !isAlive(g.pid), 5000), 'pare-feu gardé sans confirmation')
        const log = pfLog()
        check(log.includes('-F all') && !log.includes('-X'), `pfctl : ${log.trim()}`)
      } finally {
        kill(tor, g)
      }
    })
    await test('garde du pare-feu : confirmé → gardé ; Tor arrêté → retiré au bout de la grâce', async () => {
      const tor = fakeTor()
      const g = pfGuard('7', 2, 2)
      try {
        writeFileSync(path.join(dir, 'pare-feu.ok'), String(g.pid))
        await new Promise((r) => setTimeout(r, 4000))
        check(isAlive(g.pid) && !pfLog(), 'pare-feu retiré malgré la confirmation et Tor vivant')
        tor.kill('SIGKILL')
        check(await until(() => !isAlive(g.pid), 5000), 'pare-feu gardé alors que Tor est arrêté')
        check(pfLog().includes('-X 7'), 'jeton pas rendu')
      } finally {
        kill(tor, g)
      }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

await test('serveur local : page, garde-fous Host/Origin, erreurs', async () => {
  const port = 5599
  const srv = spawn(process.execPath, [new URL('./app.ts', import.meta.url).pathname], { env: { ...process.env, LUMEN_VPN_PORT: String(port) }, stdio: 'ignore' })
  try {
    for (let i = 0; i < 50 && (await portFree(port)); i++) await new Promise((r) => setTimeout(r, 100))
    const B = `http://127.0.0.1:${port}`
    const page = await fetch(B + '/')
    check(page.status === 200 && (await page.text()).includes('Lumen VPN'), 'page absente')
    const st = (await (await fetch(B + '/api/status')).json()) as { available: { tor: boolean } }
    check(typeof st.available?.tor === 'boolean', 'statut mal formé')
    const post = (body: string, headers: Record<string, string>) => fetch(B + '/api/connect', { method: 'POST', body, headers })
    check((await post('{}', { 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status === 403, 'Origin étrangère acceptée')
    check((await post('{}', { 'Content-Type': 'text/plain' })).status === 403, 'POST non-JSON accepté')
    check((await post('{pas du json', { 'Content-Type': 'application/json' })).status === 400, 'JSON cassé : pas 400')
    check((await post('null', { 'Content-Type': 'application/json' })).status === 400, 'corps null : pas 400')
    check((await post('{"country":"xx"}', { 'Content-Type': 'application/json' })).status === 400, 'pays invalide : pas 400')
    const big = await post(JSON.stringify({ country: 'x'.repeat(20_000) }), { 'Content-Type': 'application/json' }).then((r) => r.status, () => 'coupée')
    check(big === 413 || big === 'coupée', `corps énorme : ${big}`)
    check((await fetch(B + '/api/rien')).status === 404, 'route inconnue : pas 404')
    // Requête au nom d'un autre hôte (DNS rebinding) : fetch impose Host, on passe par un socket brut
    const raw = await new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET /api/status HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'))
      let b = ''
      s.on('data', (d) => (b += d))
      s.on('end', () => resolve(b))
    })
    check(raw.startsWith('HTTP/1.1 403'), 'Host étranger accepté')
  } finally {
    srv.kill()
  }
})

if (process.argv.includes('--reseau')) {
  console.log('Réseau (Tor, proxy seul)')
  const before = await status()
  if (before.connected || before.busy) {
    console.log('  – une connexion est active : tests réseau sautés pour ne pas la couper (déconnecte-toi puis relance)')
  } else {
    const where = async (code: string, extra: { renew?: boolean } = {}) => {
      const s = await connect({ country: code, system: false, ...extra })
      check(s.connected && !s.system, 'pas connecté en mode proxy seul')
      check(!code || s.place?.country === code, `les sites voient ${s.place?.countryName} au lieu de ${countryName(code)}`)
      return s
    }
    try {
      await test('connexion Allemagne', async () => void (await where('de')))
      for (const c of ['nl', 'us', 'ch', 'se', 'fr']) await test(`bascule ${countryName(c)}`, async () => void (await where(c)))
      await test('nouvelle adresse IP', async () => {
        const a = (await status()).place?.ip
        const b = (await where('fr', { renew: true })).place?.ip
        check(a && b && a !== b, 'même adresse')
      })
      await test('au plus rapide', async () => void (await where('')))
      await test('deux connexions en même temps → 409', async () => {
        const first = connect({ country: 'de', system: false })
        await rejects(connect({ country: 'nl', system: false }), /Patiente/, 409)
        await first
      })
    } finally {
      await test('déconnexion : Tor arrêté, ports libérés', async () => {
        await disconnect()
        check(!(await status()).connected, 'toujours connecté')
        check((await portFree(9450)) && (await portFree(9451)), 'ports 9450/9451 encore pris')
      })
    }
  }
}

console.log(`\n${ok} réussi${ok > 1 ? 's' : ''}, ${ko} échoué${ko > 1 ? 's' : ''}`)
process.exitCode = ko ? 1 : 0
