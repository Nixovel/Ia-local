// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Pont local de l'agent Lumen : exécute les outils demandés par le modèle (commandes, fichiers, apps…)
 * pour le compte de l'interface. Il tourne dans le serveur Vite (dev et preview), uniquement sur 127.0.0.1.
 *
 * Sécurité :
 *  - seules les requêtes du même site (Host/Origin locaux, Sec-Fetch-Site same-origin) sont acceptées ;
 *  - chaque appel d'outil exige un jeton aléatoire régénéré à chaque démarrage (en-tête x-lumen-token) ;
 *  - aucune réponse CORS : une page web tierce ne peut ni lire le jeton ni appeler les outils.
 *  La validation « Autoriser / Refuser » de chaque action sensible se fait dans l'interface.
 */
import type { Connect, Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs, createWriteStream, existsSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLab, LAB_TOOL_NAMES, labAction, labInput, labScreen, labStatus, labTool, parseScreenInput } from './lab'
import { buildExe } from './exe'
import { vpnRoute, vpnTool } from './vpn'

const TOKEN = randomBytes(24).toString('hex')
const MAX_OUT = 20_000
const MAX_READ = 200 * 1024
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

/** Shell de l'utilisateur pour run_command : PowerShell sous Windows, le shell de connexion ailleurs. */
function shellFor(command: string): [string, string[]] {
  if (isWin) return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]]
  const sh = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash')
  return [sh, ['-lc', command]]
}

/** Chaîne sûre entre apostrophes pour PowerShell. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

type ToolResult = { ok: boolean; output: string; image?: string; cwd?: string }

const expand = (p: string, cwd: string) => {
  let x = p.trim()
  if (x === '~' || x.startsWith('~/')) x = path.join(os.homedir(), x.slice(1))
  return path.resolve(cwd, x)
}

const clip = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (${s.length - MAX_OUT} caractères tronqués)` : s)

function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}) {
  return new Promise<{ code: number | null; out: string; timedOut: boolean }>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: (() => {
        const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', NO_COLOR: '1' }
        delete env.FORCE_COLOR // sinon Node avertit que NO_COLOR est ignoré
        return env
      })(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let timedOut = false
    const onData = (d: Buffer) => {
      if (out.length < MAX_OUT * 2) out += d.toString()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeout ?? 60_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(e), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, timedOut })
    })
    child.stdin.end() // les commandes interactives reçoivent EOF au lieu de bloquer
  })
}

// ---------- Lecture d'une page web (option « Recherche Internet », quand Ollama n'est relié à aucun compte) ----------
/** Adresses locales, privées ou réservées : refusées, pour qu'une page ne puisse pas faire lire le réseau local au modèle. */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase()
    if (x === '::1' || x === '::') return true
    if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7))
    return /^(fc|fd|fe[89ab])/.test(x)
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })

function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  // Code, menus, en-têtes et pieds de page : pas du contenu
  let t = html
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|aside|footer|header|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const main = t.match(/<(main|article)\b[\s\S]*?<\/\1>/i)?.[0]
  if (main && main.length > 800) t = main // le contenu principal, sans menus ni pied de page
  t = t
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/ul|\/ol|\/table|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  t = decodeEntities(t).replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title, text: t }
}

async function fetchUrl(start: string): Promise<ToolResult> {
  let url = start
  for (let hop = 0; hop < 5; hop++) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { ok: false, output: `URL invalide : ${url}` }
    }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, output: 'Seules les adresses http(s) sont acceptées.' }
    const addrs = await lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => [])
    if (!addrs.length) return { ok: false, output: `Adresse introuvable : ${u.hostname}` }
    if (addrs.some((x) => isPrivateIp(x.address))) return { ok: false, output: 'Adresse locale ou privée refusée.' }
    const r = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Lumen/1.0 (assistant local)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'fr,en;q=0.8' },
    })
    const loc = r.headers.get('location')
    if (r.status >= 300 && r.status < 400 && loc) {
      url = new URL(loc, u).href // chaque redirection est revérifiée
      continue
    }
    if (!r.ok) return { ok: false, output: `La page a répondu ${r.status} ${r.statusText}.` }
    const type = r.headers.get('content-type') ?? ''
    if (type && !/text\/|json|xml/i.test(type)) return { ok: false, output: `Contenu non textuel (${type}).` }
    if (Number(r.headers.get('content-length') ?? 0) > 5 * 1024 * 1024) return { ok: false, output: 'Page trop volumineuse.' }
    const body = Buffer.from(await r.arrayBuffer()).subarray(0, 5 * 1024 * 1024).toString('utf8')
    const { title, text } = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : { title: '', text: body }
    const page = `${title || u.hostname}\n${u.href}\n\n${text}`
    return { ok: true, output: page.length > 12_000 ? `${page.slice(0, 12_000)}\n… (page tronquée)` : page }
  }
  return { ok: false, output: 'Trop de redirections.' }
}

/** Capture de l'écran principal, réduite à 1600 px de large, selon le système. */
async function captureScreen(file: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isMac) {
    const r = await run('screencapture', ['-x', '-t', 'png', file], { timeout: 20_000 })
    if (r.code !== 0) return { ok: false, error: r.out.trim() || "Capture impossible (autorisation « Enregistrement de l'écran » ?)." }
    await run('sips', ['-Z', '1600', file], { timeout: 20_000 })
    return { ok: true }
  }
  if (isWin) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
      '$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
      '$k = [Math]::Min(1, 1600 / $b.Width); $w = [int]($b.Width * $k); $h = [int]($b.Height * $k)',
      '$out = New-Object System.Drawing.Bitmap $w, $h; $g2 = [System.Drawing.Graphics]::FromImage($out)',
      '$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g2.DrawImage($bmp, 0, 0, $w, $h)',
      `$out.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join('; ')
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000 })
    return r.code === 0 ? { ok: true } : { ok: false, error: r.out.trim() || 'Capture impossible.' }
  }
  // Linux : le premier outil de capture disponible (Wayland ou X11)
  const tools: [string, string[]][] = [
    ['grim', [file]],
    ['gnome-screenshot', ['-f', file]],
    ['spectacle', ['-b', '-n', '-o', file]],
    ['scrot', ['-o', file]],
    ['import', ['-window', 'root', file]],
  ]
  for (const [cmd, args] of tools) {
    const r = await run(cmd, args, { timeout: 20_000 })
    if (r.code === 0 && (await fs.stat(file).then((s) => s.size > 0, () => false))) {
      await run('convert', [file, '-resize', '1600x1600>', file], { timeout: 20_000 }) // si ImageMagick est là
      return { ok: true }
    }
  }
  return { ok: false, error: "Aucun outil de capture trouvé : installez par exemple « gnome-screenshot », « grim » ou « scrot »." }
}

async function runTool(name: string, a: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  switch (name) {
    case 'set_working_dir': {
      const p = expand(str('path') || '~', cwd)
      const st = await fs.stat(p).catch(() => null)
      if (!st) return { ok: false, output: `Dossier introuvable : ${p} (créez-le avec run_command « mkdir -p »).` }
      if (!st.isDirectory()) return { ok: false, output: `${p} n'est pas un dossier.` }
      return { ok: true, output: `Dossier de travail : ${p}`, cwd: p }
    }
    case 'run_command': {
      const command = str('command')
      if (!command) return { ok: false, output: 'Paramètre « command » manquant.' }
      const dir = str('cwd') ? expand(str('cwd'), cwd) : cwd
      const timeout = Math.min(300, Math.max(1, Number(a.timeout) || 60)) * 1000
      const [sh, args] = shellFor(command)
      const r = await run(sh, args, { cwd: dir, timeout })
      const note = r.timedOut ? `\n[arrêtée : plus de ${timeout / 1000} s]` : ''
      return { ok: r.code === 0, output: `${clip(r.out.trim() || '(aucune sortie)')}${note}\n[code de sortie : ${r.code}]` }
    }
    case 'read_file': {
      const p = expand(str('path'), cwd)
      const st = await fs.stat(p)
      if (st.isDirectory()) return { ok: false, output: `${p} est un dossier : utilisez list_dir.` }
      const buf = await fs.readFile(p)
      const slice = buf.subarray(0, MAX_READ)
      if (slice.includes(0)) return { ok: false, output: `${p} est un fichier binaire (${st.size} octets).` }
      const more = buf.length > MAX_READ ? `\n… (fichier tronqué : ${buf.length} octets au total)` : ''
      return { ok: true, output: slice.toString('utf8') + more }
    }
    case 'write_file': {
      const p = expand(str('path'), cwd)
      const content = typeof a.content === 'string' ? a.content : ''
      await fs.mkdir(path.dirname(p), { recursive: true })
      const existed = await fs.stat(p).then(() => true, () => false)
      await fs.writeFile(p, content, 'utf8')
      return { ok: true, output: `${existed ? 'Remplacé' : 'Créé'} : ${p} (${Buffer.byteLength(content)} octets)` }
    }
    case 'list_dir': {
      const p = expand(str('path') || '.', cwd)
      const entries = await fs.readdir(p, { withFileTypes: true })
      const hidden = a.show_hidden === true
      const rows = await Promise.all(
        entries
          .filter((e) => hidden || !e.name.startsWith('.'))
          .sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name))
          .slice(0, 300)
          .map(async (e) => {
            if (e.isDirectory()) return `${e.name}/`
            const size = await fs.stat(path.join(p, e.name)).then((s) => s.size, () => 0)
            return `${e.name}  (${size < 1024 ? `${size} o` : size < 1048576 ? `${(size / 1024).toFixed(1)} Ko` : `${(size / 1048576).toFixed(1)} Mo`})`
          }),
      )
      const more = entries.length > 300 ? `\n… et ${entries.length - 300} autres éléments` : ''
      return { ok: true, output: `${p}\n${rows.join('\n') || '(dossier vide)'}${more}` }
    }
    case 'open': {
      const target = str('target').trim()
      if (!target) return { ok: false, output: 'Paramètre « target » manquant.' }
      const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
      const p = isUrl ? target : expand(target, cwd)
      const exists = !isUrl && (await fs.stat(p).then(() => true, () => false))
      let r: Awaited<ReturnType<typeof run>>
      if (isMac) r = await run('open', isUrl || exists ? [p] : ['-a', target], { timeout: 20_000 })
      // Windows : Start-Process ouvre fichiers, dossiers, URL et applications (« notepad », « calc », « spotify »…)
      else if (isWin) r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process ${psQuote(isUrl || exists ? p : target)}`], { timeout: 20_000 })
      else if (isUrl || exists) r = await run('xdg-open', [p], { timeout: 20_000 })
      // Linux, nom d'application : lanceur .desktop (gtk-launch), sinon la commande elle-même, détachée
      else {
        r = await run('gtk-launch', [target.toLowerCase()], { timeout: 20_000 })
        if (r.code !== 0) r = await run('sh', ['-c', `command -v "$1" >/dev/null && (setsid "$1" >/dev/null 2>&1 &)`, 'sh', target.toLowerCase()], { timeout: 20_000 })
      }
      return r.code === 0 ? { ok: true, output: `Ouvert : ${target}` } : { ok: false, output: r.out.trim() || `Impossible d'ouvrir « ${target} » (application introuvable ?).` }
    }
    case 'screenshot': {
      const file = path.join(os.tmpdir(), `lumen-capture-${Date.now()}.png`)
      const r = await captureScreen(file)
      if (!r.ok) return { ok: false, output: r.error }
      const data = await fs.readFile(file)
      await fs.rm(file, { force: true })
      return { ok: true, output: "Capture d'écran prise (réduite à 1600 px).", image: `data:image/png;base64,${data.toString('base64')}` }
    }
    case 'applescript': {
      if (!isMac) return { ok: false, output: "AppleScript n'est disponible que sur macOS." }
      const script = str('script')
      if (!script) return { ok: false, output: 'Paramètre « script » manquant.' }
      const r = await run('osascript', ['-e', script], { timeout: 30_000 })
      return { ok: r.code === 0, output: clip(r.out.trim() || '(aucun résultat)') }
    }
    case 'fetch_url':
      return fetchUrl(str('url'))
    default:
      // Compilateur .exe (agent/exe.ts) et labos isolés (agent/lab.ts)
      if (name === 'build_exe') return buildExe(a)
      if (name === 'vpn') return vpnTool(a) // Lumen VPN (agent/vpn.ts → vpn/vpn.ts)
      if (LAB_TOOL_NAMES.has(name)) return labTool(name, a, cwd)
      return { ok: false, output: `Outil inconnu : ${name}` }
  }
}

// ---------- Profil matériel (sert à conseiller des modèles adaptés à la machine) ----------
type Gpu = { kind: 'apple' | 'nvidia' | 'amd' | 'intel' | 'none'; name: string; vramGB?: number; cores?: number; unified?: boolean }
type SystemInfo = { platform: string; arch: string; cpu: string; cores: number; ramGB: number; gpu: Gpu; diskFreeGB: number | null }

const gpuKind = (name: string): Gpu['kind'] =>
  /nvidia|geforce|rtx|gtx|quadro/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel|iris|uhd/i.test(name) ? 'intel' : 'none'

let systemCache: { at: number; info: SystemInfo } | null = null

async function detectSystem(): Promise<SystemInfo> {
  if (systemCache && Date.now() - systemCache.at < 5 * 60_000) return systemCache.info
  const cpus = os.cpus()
  const info: SystemInfo = {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model?.trim() && cpus[0].model.trim() !== 'unknown' ? cpus[0].model.trim() : 'Processeur',
    cores: cpus.length,
    ramGB: os.totalmem() / 2 ** 30,
    gpu: { kind: 'none', name: '' },
    diskFreeGB: null,
  }
  if (isMac) {
    const r = await run('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 10_000 })
    try {
      const d = (JSON.parse(r.out).SPDisplaysDataType ?? [])[0] ?? {}
      const name = String(d.sppci_model ?? info.cpu)
      if (process.arch === 'arm64') info.gpu = { kind: 'apple', name, cores: Number(d.sppci_cores) || undefined, unified: true }
      else info.gpu = { kind: gpuKind(name), name, vramGB: parseFloat(String(d.spdisplays_vram ?? d.spdisplays_vram_shared ?? '')) || undefined }
    } catch {
      info.gpu = process.arch === 'arm64' ? { kind: 'apple', name: info.cpu, unified: true } : { kind: 'none', name: '' }
    }
  } else {
    const n = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 6000 })
    const line = n.code === 0 ? n.out.trim().split('\n')[0] : ''
    if (line) {
      const [name, mib] = line.split(',')
      info.gpu = { kind: 'nvidia', name: name.trim(), vramGB: Number(mib) / 1024 }
    } else if (process.platform === 'win32') {
      const w = await run('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json'], { timeout: 8000 })
      try {
        const list = [JSON.parse(w.out)].flat() as { Name?: string; AdapterRAM?: number }[]
        const best = list.sort((a, b) => (b.AdapterRAM ?? 0) - (a.AdapterRAM ?? 0))[0]
        if (best?.Name) info.gpu = { kind: gpuKind(best.Name), name: best.Name, vramGB: best.AdapterRAM ? best.AdapterRAM / 2 ** 30 : undefined }
      } catch {
        /* pas de carte détectée */
      }
    } else {
      const l = await run('sh', ['-c', 'lspci 2>/dev/null | grep -iE "vga|3d" | head -1'], { timeout: 5000 })
      const name = l.out.split(':').slice(2).join(':').trim()
      if (name) info.gpu = { kind: gpuKind(name), name }
    }
  }
  // Linux ARM : le modèle du processeur n'est souvent que dans /proc/cpuinfo
  if (info.cpu === 'Processeur' && process.platform === 'linux') {
    const ci = await fs.readFile('/proc/cpuinfo', 'utf8').catch(() => '')
    const name = ci.match(/^(?:model name|Hardware|Model)\s*:\s*(.+)$/m)?.[1]?.trim()
    if (name) info.cpu = name
    else if (process.arch === 'arm64') info.cpu = 'Processeur ARM 64 bits'
  }
  const st = await fs.statfs(path.join(os.homedir(), '.ollama')).catch(() => fs.statfs(os.homedir()))
  info.diskFreeGB = (Number(st.bavail) * Number(st.bsize)) / 2 ** 30
  systemCache = { at: Date.now(), info }
  return info
}

// ---------- Ollama : détection, installation et démarrage (assistant d'installation de l'interface) ----------
const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
const LUMEN_HOME = path.join(os.homedir(), '.lumen')
const winOllamaDir = () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama')
const macOllamaApp = () => ['/Applications/Ollama.app', path.join(os.homedir(), 'Applications', 'Ollama.app')].find((p) => existsSync(p))

async function ollamaUp(): Promise<boolean> {
  try {
    return (await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}

async function which(cmd: string): Promise<string | null> {
  const r = await run(isWin ? 'where' : 'sh', isWin ? [cmd] : ['-c', `command -v "$1"`, 'sh', cmd], { timeout: 5000 })
  return r.code === 0 ? r.out.trim().split(/\r?\n/)[0] || null : null
}

/** Exécutable `ollama` : dans le PATH, ou installé par l'application / par Lumen. */
async function ollamaBinary(): Promise<string | null> {
  const known = [
    isWin ? path.join(winOllamaDir(), 'ollama.exe') : '',
    path.join(LUMEN_HOME, 'ollama', 'bin', 'ollama'),
    isMac ? '/Applications/Ollama.app/Contents/Resources/ollama' : '',
  ].filter((p) => p && existsSync(p))
  return (await which('ollama')) ?? known[0] ?? null
}

async function ollamaStatus() {
  const running = await ollamaUp()
  const installed = running || !!(isMac && macOllamaApp()) || !!(isWin && existsSync(path.join(winOllamaDir(), 'ollama.exe'))) || !!(await ollamaBinary())
  const zstd = process.platform === 'linux' ? !!(await which('zstd')) : true
  return { platform: process.platform, installed, running, canInstall: zstd, command: 'curl -fsSL https://ollama.com/install.sh | sh' }
}

async function startOllama(): Promise<boolean> {
  if (await ollamaUp()) return true
  const app = isMac ? macOllamaApp() : isWin ? path.join(winOllamaDir(), 'ollama app.exe') : null
  if (app && existsSync(app)) {
    if (isMac) await run('open', ['-ga', app], { timeout: 10_000 })
    else spawn(app, [], { detached: true, stdio: 'ignore' }).unref()
  } else {
    const bin = await ollamaBinary()
    if (!bin) return false
    spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }
  for (let i = 0; i < 40; i++) {
    if (await ollamaUp()) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

async function download(url: string, file: string, progress: (loaded: number, total: number) => void) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const out = createWriteStream(file)
  let loaded = 0
  let last = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    loaded += value.length
    if (!out.write(value)) await new Promise((r) => out.once('drain', r))
    if (Date.now() - last > 250) {
      last = Date.now()
      progress(loaded, total)
    }
  }
  progress(loaded, total)
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
}

/** Installe Ollama depuis ses téléchargements officiels, sans droits administrateur quand c'est possible. */
async function installOllama(emit: (o: Record<string, unknown>) => void) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-ollama-'))
  const progress = (loaded: number, total: number) => emit({ status: 'download', loaded, total })
  try {
    if (isMac) {
      const zip = path.join(tmp, 'Ollama.zip')
      await download('https://ollama.com/download/Ollama-darwin.zip', zip, progress)
      emit({ status: 'install' })
      let dest = '/Applications'
      try {
        await fs.access(dest, 2) // écriture autorisée ?
      } catch {
        dest = path.join(os.homedir(), 'Applications')
        await fs.mkdir(dest, { recursive: true })
      }
      const r = await run('ditto', ['-xk', zip, dest], { timeout: 120_000 })
      if (r.code !== 0) throw new Error(r.out.trim() || 'Copie de l’application impossible')
    } else if (isWin) {
      const exe = path.join(tmp, 'OllamaSetup.exe')
      await download('https://ollama.com/download/OllamaSetup.exe', exe, progress)
      emit({ status: 'install' })
      const r = await run(exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], { timeout: 300_000 })
      if (r.code !== 0) throw new Error(r.out.trim() || `Installateur terminé avec le code ${r.code}`)
    } else {
      if (!(await which('zstd'))) throw new Error('needs-command')
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
      const archive = path.join(tmp, 'ollama.tar.zst')
      await download(`https://ollama.com/download/ollama-linux-${arch}.tar.zst`, archive, progress)
      emit({ status: 'install' })
      const dest = path.join(LUMEN_HOME, 'ollama')
      await fs.mkdir(dest, { recursive: true })
      const r = await run('tar', ['--use-compress-program=unzstd', '-xf', archive, '-C', dest], { timeout: 300_000 })
      if (r.code !== 0) throw new Error(r.out.trim() || 'Extraction impossible')
    }
    emit({ status: 'start' })
    if (!(await startOllama())) throw new Error('Ollama est installé mais ne démarre pas : lancez-le depuis vos applications.')
    emit({ done: true })
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------- Utilisation en direct (jauges mémoire / processeur / GPU de l'interface) ----------
type Usage = { ramTotalGB: number; ramUsedGB: number; cpuPct: number; gpuPct: number | null; gpuMemUsedGB: number | null; gpuMemTotalGB: number | null }

const cpuTimes = () => {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}
let cpuPrev = cpuTimes()
let usageCache: { at: number; p: Promise<Usage> } | null = null

async function measureUsage(): Promise<Usage> {
  const now = cpuTimes()
  const dTotal = now.total - cpuPrev.total
  const cpuPct = dTotal > 0 ? Math.round((1 - (now.idle - cpuPrev.idle) / dTotal) * 100) : 0
  cpuPrev = now
  const total = os.totalmem()
  let used = total - os.freemem()
  const u: Usage = { ramTotalGB: total / 2 ** 30, ramUsedGB: 0, cpuPct, gpuPct: null, gpuMemUsedGB: null, gpuMemTotalGB: null }
  if (isMac) {
    // os.freemem() ignore les caches que macOS libère à la demande : on compte comme le Moniteur d'activité
    const [vm, io] = await Promise.all([
      run('vm_stat', [], { timeout: 3000 }),
      run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 3000 }),
    ])
    const page = Number(vm.out.match(/page size of (\d+)/)?.[1]) || 16384
    const pages = (label: string) => Number(vm.out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0)
    const free = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')
    if (free) used = total - free * page
    const util = io.out.match(/"Device Utilization %"=(\d+)/)
    if (util) u.gpuPct = Number(util[1])
    const mem = io.out.match(/"In use system memory"=(\d+)/)
    if (mem) u.gpuMemUsedGB = Number(mem[1]) / 2 ** 30
  } else {
    if (process.platform === 'linux') {
      const mi = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '')
      const avail = Number(mi.match(/MemAvailable:\s+(\d+)/)?.[1])
      if (avail) used = total - avail * 1024
    }
    if (systemCache?.info.gpu.kind === 'nvidia') {
      const n = await run('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000 })
      const [g, mu, mt] = (n.code === 0 ? n.out.trim().split('\n')[0] : '').split(',').map((x) => Number(x.trim()))
      if (Number.isFinite(g)) u.gpuPct = g
      if (Number.isFinite(mu)) u.gpuMemUsedGB = mu / 1024
      if (Number.isFinite(mt)) u.gpuMemTotalGB = mt / 1024
    }
  }
  u.ramUsedGB = Math.max(0, used) / 2 ** 30
  return u
}

/** Une mesure au plus par seconde, même si plusieurs onglets interrogent le pont. */
function usage(): Promise<Usage> {
  if (!usageCache || Date.now() - usageCache.at > 1000) usageCache = { at: Date.now(), p: measureUsage() }
  return usageCache.p
}

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])$/
function allowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (!LOCAL.test(host)) return false
  const origin = req.headers.origin
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  return true
}

const send = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Requête trop volumineuse'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

const handler: Connect.NextHandleFunction = async (req, res, next) => {
  if (!req.url?.startsWith('/agent/')) return next()
  if (req.method === 'OPTIONS' || !allowed(req)) return send(res, 403, { ok: false, output: 'Accès refusé' })
  try {
    if (req.url === '/agent/token' && req.method === 'GET') {
      return send(res, 200, { token: TOKEN, home: os.homedir(), platform: process.platform, arch: process.arch, shell: shellFor('')[0] })
    }
    if (req.url === '/agent/lab') {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      if (req.method === 'GET') return send(res, 200, await labStatus())
      const { action, lab, value } = (await readBody(req)) as { action?: string; lab?: string; value?: unknown }
      // Progression en NDJSON (construction d'un labo, démarrage du téléphone virtuel…)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      const emit = (o: Record<string, unknown>) => {
        if (!res.writableEnded) res.write(JSON.stringify(o) + '\n')
      }
      try {
        await labAction(String(action ?? ''), lab, value, emit)
        emit({ done: true })
      } catch (e) {
        const m = (e as Error).message
        emit(
          m === 'android-license'
            ? { error: 'Licence du SDK Android à accepter (Réglages → Labos).', needsLicense: true, needs: m }
            : m === 'windows-license'
              ? { error: 'Licence de Windows 11 à accepter (Réglages → Labos → Windows complet).', needs: m }
              : m === 'windows-iso'
                ? { error: "ISO de Windows 11 ARM64 introuvable : téléchargez-la chez Microsoft (dans Téléchargements) ou choisissez-la.", needs: m }
                : { error: m },
        )
      }
      return res.end()
    }
    // Écran en direct d'un labo (panneau « Écran du labo ») : image PNG, 204 si le labo est éteint
    if (req.url?.startsWith('/agent/lab/screen') && req.method === 'GET') {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      const lab = new URL(req.url, 'http://127.0.0.1').searchParams.get('lab')
      if (!isLab(lab)) return send(res, 400, { ok: false, output: 'Labo inconnu' })
      const png = await labScreen(lab)
      res.setHeader('Cache-Control', 'no-store')
      if (!png) {
        res.statusCode = 204
        return res.end()
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      return res.end(png)
    }
    if (req.url === '/agent/lab/input' && req.method === 'POST') {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      const body = (await readBody(req)) as Record<string, unknown>
      const ev = parseScreenInput(body)
      if (!isLab(body.lab) || !ev) return send(res, 400, { ok: false, output: 'Commande invalide' })
      try {
        await labInput(body.lab, ev)
      } catch (e) {
        return send(res, 409, { ok: false, output: (e as Error).message }) // labo éteint, etc.
      }
      return send(res, 200, { ok: true })
    }
    // Page « VPN » de l'interface (agent/vpn.ts)
    if (req.url === '/agent/vpn' || req.url?.startsWith('/agent/vpn/') || req.url?.startsWith('/agent/vpn?')) {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      return vpnRoute(req, res, send, readBody)
    }
    if (req.url === '/agent/system' && req.method === 'GET') {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      return send(res, 200, await detectSystem())
    }
    if (req.url === '/agent/ollama') {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      if (req.method === 'GET') return send(res, 200, await ollamaStatus())
      const { action } = (await readBody(req)) as { action?: string }
      if (action === 'start') return send(res, 200, { ok: await startOllama() })
      if (action === 'install') {
        // Progression en NDJSON (une ligne JSON par étape), comme « ollama pull »
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        const emit = (o: Record<string, unknown>) => res.write(JSON.stringify(o) + '\n')
        try {
          await installOllama(emit)
        } catch (e) {
          const m = (e as Error).message
          emit(m === 'needs-command' ? { error: 'Sous Linux, Ollama s’installe avec une commande (mot de passe demandé).', command: 'curl -fsSL https://ollama.com/install.sh | sh' } : { error: m })
        }
        return res.end()
      }
      return send(res, 400, { ok: false, output: 'Action inconnue' })
    }
    if (req.url === '/agent/doctor' && req.method === 'GET') {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      // Le même diagnostic que « npm run doctor » / « lumen doctor »
      const script = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url))
      const r = await run(process.execPath, [script], { cwd: path.dirname(path.dirname(script)), timeout: 200_000 })
      return send(res, 200, { ok: r.code === 0, output: r.out.replace(/\x1b\[[0-9;]*m/g, '').trim() })
    }
    if (req.url === '/agent/usage' && req.method === 'GET') {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      return send(res, 200, await usage())
    }
    if (req.url === '/agent/tool' && req.method === 'POST') {
      if (req.headers['x-lumen-token'] !== TOKEN) return send(res, 401, { ok: false, output: 'Jeton invalide' })
      const body = (await readBody(req)) as { name?: string; args?: Record<string, unknown>; cwd?: string }
      const cwd = expand(body.cwd || '~', os.homedir())
      const result = await runTool(String(body.name ?? ''), body.args ?? {}, cwd).catch(
        (e: Error): ToolResult => ({ ok: false, output: e.message }),
      )
      return send(res, 200, result)
    }
    return send(res, 404, { ok: false, output: 'Introuvable' })
  } catch (e) {
    return send(res, 500, { ok: false, output: `Erreur du pont : ${(e as Error).message}` })
  }
}

export function agentBridge(): Plugin {
  return {
    name: 'lumen-agent-bridge',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}
