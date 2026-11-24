// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Labo « Windows complet » (windows-vm) : une vraie machine virtuelle Windows 11 ARM sur Mac à processeur Apple,
 * avec QEMU et l'hyperviseur de macOS (« -accel hvf »). C'est le seul labo Windows de Lumen.
 *  - Installation sans intervention depuis l'ISO officielle de Microsoft (téléchargée par l'utilisateur) : pilotes
 *    virtio ARM64 (Red Hat), autounattend.xml, compte local « lumen », OpenSSH Server, PowerShell 7, LLVM-MinGW
 *    (voir lab/windows-vm). La licence de Windows n'est acceptée qu'après l'accord de l'utilisateur dans Lumen.
 *  - L'agent y exécute du PowerShell par SSH (127.0.0.1:21022, clé dédiée), lit et écrit des fichiers, et voit l'écran
 *    (QMP « screendump ») ; l'utilisateur la regarde et la pilote depuis le panneau « Écran du labo ».
 *  - Après l'installation, un instantané « propre » du disque : « Réinitialiser » y revient en quelques secondes.
 * Fichiers : ~/.lumen/windows-vm (disque, NVRAM UEFI, clé SSH, état), ~/Lumen Labo/windows-vm (copies des fichiers écrits).
 * QEMU tourne détaché : la machine survit aux redémarrages du serveur de Lumen, l'état est relu depuis le disque.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { clip, exec, sleep, type ExecOptions } from './proc'

type ToolResult = { ok: boolean; output: string; image?: string }
type Emit = (o: Record<string, unknown>) => void
const noop: Emit = () => {}

export const VM_DIR = path.join(os.homedir(), '.lumen', 'windows-vm')
const WORK = path.join(os.homedir(), 'Lumen Labo', 'windows-vm')
const TEMPLATES = fileURLToPath(new URL('../lab/windows-vm', import.meta.url))
const F = {
  state: path.join(VM_DIR, 'state.json'),
  disk: path.join(VM_DIR, 'disk.qcow2'),
  vars: path.join(VM_DIR, 'efi-vars.fd'),
  unattend: path.join(VM_DIR, 'unattend.iso'),
  drivers: path.join(VM_DIR, 'drivers'),
  virtio: path.join(VM_DIR, 'virtio-win.iso'),
  key: path.join(VM_DIR, 'id_ed25519'),
  pid: path.join(VM_DIR, 'qemu.pid'),
  log: path.join(VM_DIR, 'qemu.log'),
}
// Les sockets Unix sont limités à 104 caractères sur macOS
const QMP_SOCK = (() => {
  const p = path.join(VM_DIR, 'qmp.sock')
  return p.length < 100 ? p : path.join('/tmp', `lumen-winvm-${process.getuid?.() ?? 0}.sock`)
})()
export const VM_SSH_PORT = 21022
/** Ports 8000 à 8004 de la machine, publiés sur l'ordinateur (127.0.0.1:21000 à 21004). */
export const VM_PORT_BASE = 21000
const USER = 'lumen'
const SNAPSHOT = 'propre'
const DISK_SIZE = '128G' // disque « à la demande » : seule la place réellement utilisée compte (≈ 20 Go)
const EDITION = 'Windows 11 Pro'
const GENERIC_KEY = 'VK7JG-NPHTM-C97JM-9MPGT-3V66T' // clé générique publique d'installation de Windows 11 Pro (n'active pas)
const VIRTIO_URL = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso'
export const WINDOWS_ISO_PAGE = 'https://www.microsoft.com/fr-fr/software-download/windows11arm64'
const DRIVERS = ['NetKVM', 'viorng', 'Balloon', 'vioserial', 'pvpanic', 'viostor', 'vioscsi']
const ISO_RE = /^win(dows)?[ _-]?11.*arm64.*\.iso$/i
const isMac = process.platform === 'darwin'

const NO_QEMU = 'Le labo Windows complet a besoin de QEMU : installez-le avec « brew install qemu » (Homebrew), puis réessayez.'
const NOT_INSTALLED = "Le labo Windows complet n'est pas installé : Réglages → Labos → « Windows complet » → Préparer (≈ 15 min, une seule fois)."
const qv = (s: string) => s.replaceAll(',', ',,') // virgules dans les chemins des options de QEMU
const mb = (n: number) => `${(n / 2 ** 20).toFixed(0)} Mo`

// ---------- État (sur le disque : survit aux redémarrages du serveur) ----------
type VmFile = {
  phase?: 'installing' | 'ready'
  iso?: string
  lang?: string
  startedAt?: number
  installedAt?: number
  password?: string
  versions?: string
  pwsh?: boolean
  license?: string
  network?: boolean
  window?: boolean
  error?: string
}

async function readState(): Promise<VmFile> {
  try {
    return JSON.parse(await fs.readFile(F.state, 'utf8')) as VmFile
  } catch {
    return {}
  }
}
async function writeState(patch: (s: VmFile) => void): Promise<VmFile> {
  const s = await readState()
  patch(s)
  await fs.mkdir(VM_DIR, { recursive: true, mode: 0o700 })
  await fs.writeFile(F.state, JSON.stringify(s, null, 2), { mode: 0o600 })
  return s
}

// ---------- QEMU ----------
export const vmSupported = () => isMac && process.arch === 'arm64'

function qemuBin(): string | null {
  for (const p of ['/opt/homebrew/bin/qemu-system-aarch64', '/usr/local/bin/qemu-system-aarch64', '/opt/local/bin/qemu-system-aarch64']) if (existsSync(p)) return p
  return null
}

function firmware(bin: string): { code: string; vars: string } | null {
  const share = path.join(path.dirname(path.dirname(realpathSync(bin))), 'share', 'qemu')
  const code = path.join(share, 'edk2-aarch64-code.fd')
  const vars = path.join(share, 'edk2-arm-vars.fd')
  return existsSync(code) && existsSync(vars) ? { code, vars } : null
}

let qemuVersion: string | null = null
async function qemuInfo(): Promise<string | null> {
  const bin = qemuBin()
  if (!bin || !firmware(bin)) return null
  if (!qemuVersion) qemuVersion = (await exec(bin, ['--version'], { timeout: 10_000 })).out.match(/version\s+([\d.]+)/)?.[1] ?? '?'
  return qemuVersion
}

const qemuPids = new Map<number, number>() // pid → instant où l'on a vérifié que c'est bien QEMU
/** PID de QEMU s'il tourne. Un fichier de PID périmé (plantage) ne doit jamais désigner un autre programme. */
function pidAlive(): number | null {
  let pid = 0
  try {
    pid = Number(readFileSync(F.pid, 'utf8').trim())
    if (!(pid > 0)) return null
    process.kill(pid, 0)
  } catch {
    return null
  }
  const seen = qemuPids.get(pid)
  if (seen && Date.now() - seen < 10_000) return pid
  const comm = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 }).stdout ?? ''
  if (!comm.includes('qemu-system')) {
    qemuPids.delete(pid)
    try {
      unlinkSync(F.pid)
    } catch {
      /* déjà supprimé */
    }
    return null
  }
  qemuPids.set(pid, Date.now())
  return pid
}

/** Démarre QEMU, détaché (la machine survit aux redémarrages de Lumen). */
async function launch(mode: 'install' | 'normal', st: VmFile) {
  const bin = qemuBin()
  const fw = bin && firmware(bin)
  if (!bin || !fw) throw new Error(NO_QEMU)
  if (pidAlive()) return
  await fs.rm(QMP_SOCK, { force: true })
  const cpus = Math.max(2, Math.min(6, os.cpus().length - 2))
  const memGB = Math.max(4, Math.min(8, Math.floor(os.totalmem() / 2 ** 30 / 4)))
  const fwd = [`hostfwd=tcp:127.0.0.1:${VM_SSH_PORT}-:22`, ...[0, 1, 2, 3, 4].map((i) => `hostfwd=tcp:127.0.0.1:${VM_PORT_BASE + i}-:${8000 + i}`)]
  // restrict=on : la machine n'a plus accès à Internet ni au réseau local (SSH et ports publiés restent accessibles).
  // Jamais pendant l'installation : OpenSSH, PowerShell 7 et LLVM-MinGW s'y téléchargent.
  const offline = st.network === false && mode === 'normal'
  const netdev = ['user', 'id=net0', ...fwd, ...(offline ? ['restrict=on'] : [])].join(',')
  const args = [
    '-name', 'Lumen Labo Windows',
    // GICv3 émulé par QEMU avec ITS (kernel-irqchip=off) : les interruptions MSI de l'USB, du NVMe et du réseau
    // fonctionnent. Avec le vGIC matériel de macOS (pas d'ITS), Windows plafonne à ≈ 4 Mo/s (mesuré : installation
    // 10 fois plus rapide avec ITS).
    '-machine', 'virt,highmem=on,kernel-irqchip=off,gic-version=3,its=on', '-accel', 'hvf', '-cpu', 'host', '-smp', String(cpus), '-m', `${memGB}G`,
    '-drive', `if=pflash,format=raw,readonly=on,file=${qv(fw.code)}`,
    '-drive', `if=pflash,format=raw,file=${qv(F.vars)}`,
    '-device', 'ramfb', // écran du micrologiciel UEFI, repris par Windows (affichage de base)
    '-device', 'qemu-xhci,id=xhci', '-device', 'usb-kbd,bus=xhci.0', '-device', 'usb-tablet,bus=xhci.0',
    '-drive', `if=none,id=disk0,format=qcow2,file=${qv(F.disk)},discard=unmap,detect-zeroes=unmap`,
    '-device', 'nvme,drive=disk0,serial=lumen-labo,bootindex=0', // NVMe : pilote inclus dans Windows ARM
    '-netdev', netdev, '-device', 'virtio-net-pci,netdev=net0,romfile=',
    '-device', 'virtio-rng-pci', '-device', 'virtio-balloon-pci',
    '-rtc', 'base=localtime',
    '-qmp', `unix:${QMP_SOCK},server=on,wait=off`,
    '-pidfile', F.pid,
    '-display', st.window ? 'cocoa' : 'none',
  ]
  if (mode === 'install' && st.iso)
    args.push(
      // ISO de Windows et CD de Lumen (autounattend.xml, pilotes, script) en lecteurs CD USB
      '-drive', `if=none,id=cd0,media=cdrom,readonly=on,file=${qv(st.iso)}`, '-device', 'usb-bot,id=bot0,bus=xhci.0', '-device', 'scsi-cd,bus=bot0.0,drive=cd0,bootindex=1',
      '-drive', `if=none,id=cd1,media=cdrom,readonly=on,file=${qv(F.unattend)}`, '-device', 'usb-bot,id=bot1,bus=xhci.0', '-device', 'scsi-cd,bus=bot1.0,drive=cd1',
    )
  const log = await fs.open(F.log, 'w')
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', log.fd, log.fd] })
  let exited: number | null = null
  child.on('exit', (c) => (exited = c ?? -1))
  child.unref()
  await log.close()
  for (let i = 0; i < 100 && exited === null; i++) {
    if (existsSync(QMP_SOCK) && pidAlive()) return
    await sleep(100)
  }
  const tail = (await fs.readFile(F.log, 'utf8').catch(() => '')).trim().split('\n').slice(-6).join('\n')
  throw new Error(`QEMU ne démarre pas.${tail ? `\n${tail}` : ''}`)
}

// ---------- QMP (contrôle de QEMU : écran, clavier, souris, arrêt) ----------
type QmpCmd = { execute: string; arguments?: Record<string, unknown> }
let qmpChain: Promise<unknown> = Promise.resolve()

/** Envoie des commandes QMP (une connexion à la fois : QEMU n'accepte qu'un client). */
function qmp<T = unknown>(cmds: QmpCmd[], timeout = 15_000): Promise<T[]> {
  const run = () =>
    new Promise<T[]>((resolve, reject) => {
      const sock = net.createConnection(QMP_SOCK)
      const out: T[] = []
      let buf = ''
      let step = -1
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error('QEMU ne répond pas (QMP).'))
      }, timeout)
      const next = () => {
        step++
        const c = step === 0 ? { execute: 'qmp_capabilities' } : cmds[step - 1]
        if (!c) {
          clearTimeout(timer)
          sock.end()
          resolve(out)
        } else sock.write(JSON.stringify(c) + '\n')
      }
      sock.on('data', (d: Buffer) => {
        buf += d.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let m: { QMP?: unknown; event?: string; error?: { desc?: string }; return?: T }
          try {
            m = JSON.parse(line)
          } catch {
            continue
          }
          if (m.QMP) next()
          else if (m.event) continue
          else if (m.error) {
            clearTimeout(timer)
            sock.destroy()
            reject(new Error(`QEMU : ${m.error.desc ?? 'erreur'}`))
            return
          } else if ('return' in m) {
            if (step > 0) out.push(m.return as T)
            next()
          }
        }
      })
      sock.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  const p = qmpChain.then(run, run)
  qmpChain = p.catch(() => {})
  return p
}

/**
 * Au tout premier démarrage, l'ISO affiche « Appuyez sur une touche pour démarrer du CD » : on appuie pour l'utilisateur
 * pendant 15 s. Flèche ↓ : elle suffit à l'invite et n'active aucun bouton de l'installateur (qui s'affiche vers 30 s).
 */
async function pressKeyToBoot() {
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    await qmp([{ execute: 'send-key', arguments: { keys: [{ type: 'qcode', data: 'down' }] } }], 3000).catch(() => {})
  }
}

// ---------- SSH (PowerShell dans la machine) ----------
const sshArgs = () => [
  '-i', F.key, '-p', String(VM_SSH_PORT),
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
]
/** Commande à distance : le shell par défaut d'OpenSSH pour Windows est cmd.exe (« cmd /c … »). */
const ssh = (remote: string, o: ExecOptions = {}) => exec('ssh', [...sshArgs(), `${USER}@127.0.0.1`, remote], o)

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`
const PRELUDE =
  "$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue';if($PSStyle){$PSStyle.OutputRendering='PlainText'};" +
  '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Text.UTF8Encoding]::new($false);' +
  "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User');"

/** Exécute un court script PowerShell (encodé : pas de souci de guillemets ; cmd.exe limite la ligne à 8 191 caractères). */
async function ps(script: string, o: ExecOptions = {}) {
  const shell = (await readState()).pwsh === false ? 'powershell.exe' : 'pwsh.exe'
  const enc = Buffer.from(PRELUDE + script, 'utf16le').toString('base64')
  const r = await ssh(`${shell} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${enc}`, o)
  return { ...r, out: decodeClixml(r.out) }
}

/** Erreurs que PowerShell écrit en CLIXML (« #< CLIXML <Objs…> ») : on n'en garde que le texte, sans codes de couleur. */
function decodeClixml(s: string): string {
  if (!s.includes('#< CLIXML')) return s
  return s
    .replace(/#< CLIXML\r?\n?/g, '')
    .replace(/<Objs[^>]*>([\s\S]*?)<\/Objs>/g, (_, body: string) =>
      [...body.matchAll(/<S S="(?:Error|Warning|Information|verbose|debug)">([\s\S]*?)<\/S>/gi)]
        .map((m) => m[1])
        .join('')
        .replace(/_x([0-9A-F]{4})_/gi, (__, h: string) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\r\n/g, '\n'),
    )
}

let sshOkAt = 0
async function sshOk(): Promise<boolean> {
  const r = await ssh('echo ok', { timeout: 15_000 })
  const ok = r.code === 0 && r.stdout.toString().includes('ok')
  if (ok) sshOkAt = Date.now()
  return ok
}

// ---------- Préparation (ISO, pilotes, clé, CD d'installation) ----------
export function findIso(saved?: string): string | null {
  if (saved && existsSync(saved)) return saved
  let best: { p: string; t: number } | null = null
  for (const d of [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop'), VM_DIR]) {
    let names: string[] = []
    try {
      names = readdirSync(d)
    } catch {
      continue
    }
    for (const f of names) {
      if (!ISO_RE.test(f)) continue
      try {
        const st = statSync(path.join(d, f))
        if (st.size > 3e9 && (!best || st.mtimeMs > best.t)) best = { p: path.join(d, f), t: st.mtimeMs }
      } catch {
        /* fichier en cours de téléchargement */
      }
    }
  }
  return best?.p ?? null
}

async function mountIso(iso: string): Promise<string> {
  const mp = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-iso-'))
  const r = await exec('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mp, iso], { timeout: 180_000 })
  if (r.code !== 0) {
    await fs.rm(mp, { recursive: true, force: true })
    throw new Error(`Lecture de l'image disque impossible (${path.basename(iso)}) : ${r.out.trim().split('\n').pop()}`)
  }
  return mp
}
async function unmountIso(mp: string) {
  await exec('hdiutil', ['detach', mp, '-force'], { timeout: 60_000 })
  await fs.rm(mp, { recursive: true, force: true }).catch(() => {})
}

/** Vérifie l'ISO de Windows (image d'installation présente) et lit sa langue (sources/lang.ini). */
async function inspectIso(iso: string): Promise<{ lang: string }> {
  const mp = await mountIso(iso)
  try {
    if (!existsSync(path.join(mp, 'sources', 'install.wim')) && !existsSync(path.join(mp, 'sources', 'install.esd')))
      throw new Error(`${path.basename(iso)} n'est pas un ISO d'installation de Windows 11 (sources/install.wim introuvable).`)
    if (!existsSync(path.join(mp, 'efi', 'microsoft', 'boot', 'cdboot.efi'))) throw new Error(`${path.basename(iso)} ne démarre pas en UEFI.`)
    const ini = await fs.readFile(path.join(mp, 'sources', 'lang.ini'), 'utf8').catch(() => '')
    const tag = ini.match(/\[Available UI Languages\]\s*\r?\n\s*([a-z]{2,3}-[a-z]{2,4})/i)?.[1] ?? 'fr-fr'
    const [l, r] = tag.split('-')
    return { lang: `${l.toLowerCase()}-${r.length === 2 ? r.toUpperCase() : r[0].toUpperCase() + r.slice(1).toLowerCase()}` }
  } finally {
    await unmountIso(mp)
  }
}

/** Téléchargement HTTPS avec progression (les redirections http:// de fedorapeople.org repassent en https://). */
async function download(url: string, dest: string, label: string, emit: Emit) {
  let u = url
  let res: Response | null = null
  for (let i = 0; i < 6; i++) {
    res = await fetch(u, { redirect: 'manual' })
    const loc = res.headers.get('location')
    if (res.status < 300 || res.status >= 400 || !loc) break
    const next = new URL(loc, u)
    if (next.protocol === 'http:') next.protocol = 'https:'
    u = next.href
  }
  if (!res?.ok || !res.body) throw new Error(`Téléchargement impossible (${res?.status ?? '?'}) : ${u}`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let last = 0
  const body = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
  body.on('data', (c: Buffer) => {
    got += c.length
    if (Date.now() - last > 700) {
      last = Date.now()
      emit({ status: 'vm-download', text: `${label} : ${mb(got)}${total ? ` / ${mb(total)}` : ''}` })
    }
  })
  await pipeline(body, createWriteStream(dest + '.part'))
  await fs.rename(dest + '.part', dest)
}

/** Pilotes virtio ARM64 pour Windows 11 (réseau, aléatoire, mémoire…), extraits de l'ISO virtio-win de Red Hat. */
async function ensureDrivers(emit: Emit) {
  if (existsSync(path.join(F.drivers, 'NetKVM'))) return
  if (!existsSync(F.virtio)) await download(VIRTIO_URL, F.virtio, 'Pilotes virtio-win (Red Hat)', emit)
  emit({ status: 'vm-iso', text: 'Extraction des pilotes ARM64…' })
  const mp = await mountIso(F.virtio)
  const tmp = `${F.drivers}.tmp`
  try {
    await fs.rm(tmp, { recursive: true, force: true })
    await fs.mkdir(tmp, { recursive: true })
    for (const d of DRIVERS) {
      const src = path.join(mp, d, 'w11', 'ARM64')
      if (existsSync(src)) await fs.cp(src, path.join(tmp, d), { recursive: true })
    }
    await exec('chmod', ['-R', 'u+w', tmp]) // copies d'un CD : lecture seule
    if (!existsSync(path.join(tmp, 'NetKVM'))) throw new Error('Pilotes ARM64 introuvables dans virtio-win.iso.')
    await fs.rm(F.drivers, { recursive: true, force: true })
    await fs.rename(tmp, F.drivers)
  } finally {
    await unmountIso(mp)
  }
  await fs.rm(F.virtio, { force: true })
}

async function ensureKey() {
  if (existsSync(F.key) && existsSync(`${F.key}.pub`)) return
  await fs.rm(F.key, { force: true })
  const r = await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'lumen-labo', '-f', F.key], { timeout: 20_000 })
  if (r.code !== 0) throw new Error(`Création de la clé SSH impossible : ${r.out.trim()}`)
}

/** Fuseau horaire Windows correspondant à celui de l'ordinateur (UTC sinon). */
function windowsTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const map: Record<string, string> = {
    'Europe/Paris': 'Romance Standard Time', 'Europe/Brussels': 'Romance Standard Time', 'Europe/Madrid': 'Romance Standard Time', 'Europe/Copenhagen': 'Romance Standard Time',
    'Europe/Berlin': 'W. Europe Standard Time', 'Europe/Zurich': 'W. Europe Standard Time', 'Europe/Rome': 'W. Europe Standard Time', 'Europe/Amsterdam': 'W. Europe Standard Time',
    'Europe/Vienna': 'W. Europe Standard Time', 'Europe/Luxembourg': 'W. Europe Standard Time', 'Europe/Monaco': 'W. Europe Standard Time', 'Europe/Stockholm': 'W. Europe Standard Time',
    'Europe/London': 'GMT Standard Time', 'Europe/Dublin': 'GMT Standard Time', 'Europe/Lisbon': 'GMT Standard Time',
    'America/New_York': 'Eastern Standard Time', 'America/Toronto': 'Eastern Standard Time', 'America/Montreal': 'Eastern Standard Time',
    'America/Chicago': 'Central Standard Time', 'America/Denver': 'Mountain Standard Time', 'America/Los_Angeles': 'Pacific Standard Time',
    'Africa/Casablanca': 'Morocco Standard Time', 'Africa/Algiers': 'W. Central Africa Standard Time', 'Africa/Tunis': 'W. Central Africa Standard Time',
    'Africa/Dakar': 'Greenwich Standard Time', 'Africa/Abidjan': 'Greenwich Standard Time', 'Indian/Reunion': 'Mauritius Standard Time',
    'America/Guadeloupe': 'SA Western Standard Time', 'America/Martinique': 'SA Western Standard Time', 'Asia/Tokyo': 'Tokyo Standard Time',
  }
  return map[tz] ?? 'UTC'
}

/** CD de Lumen : autounattend.xml (rempli), script de configuration, clé publique SSH, pilotes. */
async function buildUnattend(st: VmFile) {
  const dir = path.join(VM_DIR, 'unattend')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(path.join(dir, 'lumen'), { recursive: true })
  const lang = st.lang ?? 'fr-FR'
  const fill: Record<string, string> = {
    LANG: lang, INPUT: lang, EDITION: EDITION, KEY: GENERIC_KEY, TIMEZONE: windowsTimeZone(), USER, PASSWORD: st.password ?? '',
  }
  const xml = readFileSync(path.join(TEMPLATES, 'autounattend.xml'), 'utf8').replace(/\{\{([A-Z]+)\}\}/g, (_, k: string) => fill[k] ?? '')
  await fs.writeFile(path.join(dir, 'autounattend.xml'), xml)
  // Windows PowerShell 5.1 lit les scripts sans BOM en ANSI : BOM UTF-8 et fins de ligne Windows
  await fs.writeFile(path.join(dir, 'lumen', 'setup.ps1'), '\ufeff' + readFileSync(path.join(TEMPLATES, 'setup.ps1'), 'utf8').replace(/\r?\n/g, '\r\n'))
  await fs.copyFile(`${F.key}.pub`, path.join(dir, 'lumen', 'authorized_keys'))
  await fs.cp(F.drivers, path.join(dir, 'lumen', 'drivers'), { recursive: true })
  await fs.rm(F.unattend, { force: true })
  const r = await exec('hdiutil', ['makehybrid', '-iso', '-joliet', '-default-volume-name', 'LUMEN', '-o', F.unattend, dir], { timeout: 120_000 })
  await fs.rm(dir, { recursive: true, force: true }) // contient le mot de passe du compte
  if (r.code !== 0) throw new Error(`Création du CD d'installation impossible : ${r.out.trim()}`)
}

async function qemuImg(args: string[]) {
  const bin = qemuBin()
  if (!bin) throw new Error(NO_QEMU)
  const r = await exec(path.join(path.dirname(bin), 'qemu-img'), args, { timeout: 300_000 })
  if (r.code !== 0) throw new Error(`qemu-img ${args[0]} : ${r.out.trim()}`)
  return r.out
}

// ---------- Cycle de vie ----------
let busy: string | null = null
let progress: string | null = null
const inflight = new Map<string, Promise<void>>()
function once(key: string, fn: () => Promise<void>): Promise<void> {
  const cur = inflight.get(key)
  if (cur) return cur
  const p = fn().finally(() => {
    inflight.delete(key)
    if (!inflight.size) {
      busy = null
      progress = null
    }
  })
  inflight.set(key, p)
  return p
}
const say = (emit: Emit) => (o: Record<string, unknown>) => {
  if (typeof o.text === 'string') progress = o.text
  emit(o)
}

const minutesSince = (t?: number) => (t ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : 0)

/**
 * Verrou sur le disque : une seule finalisation à la fois, même si deux instances de ce module tournent (après un
 * redémarrage du serveur de Lumen, l'ancienne attente d'installation continue à côté de la nouvelle).
 */
const lockFile = (name: string) => path.join(VM_DIR, `${name}.lock`)
const locked = (name: string) => {
  try {
    return Date.now() - statSync(lockFile(name)).mtimeMs < 15 * 60_000
  } catch {
    return false
  }
}
async function withLock(name: string, fn: () => Promise<void>): Promise<void> {
  if (locked(name)) return
  await fs.rm(lockFile(name), { force: true }) // verrou abandonné (plus de 15 min)
  try {
    await (await fs.open(lockFile(name), 'wx')).close()
  } catch {
    return // une autre instance vient de le prendre
  }
  try {
    await fn()
  } finally {
    await fs.rm(lockFile(name), { force: true })
  }
}

let installCheck: Promise<void> | null = null
let installCheckAt = 0
/** Pendant l'installation : la machine est-elle prête (C:\lumen\ready) ? Si oui, on la finalise. Idempotent. */
function checkInstall(force = false): Promise<void> {
  if (installCheck) return installCheck
  if (!force && Date.now() - installCheckAt < 15_000) return Promise.resolve()
  installCheckAt = Date.now()
  installCheck = (async () => {
    const st = await readState()
    if (st.phase !== 'installing' || inflight.has('finalize') || locked('finalize')) return
    if (!pidAlive()) {
      if (!inflight.has('prepare') && !st.error) await writeState((s) => void (s.error = "La machine s'est arrêtée pendant l'installation : « Préparer » la relance là où elle en était."))
      return
    }
    const r = await ssh('if exist C:\\lumen\\ready (type C:\\lumen\\versions.txt) else (exit /b 7)', { timeout: 20_000 })
    if (r.code === 0) await withLock('finalize', () => finalize(r.stdout.toString().replace(/^\ufeff/, '').trim(), noop))
  })()
    .catch(async (e: Error) => {
      // Jamais de rejet non géré (il arrêterait le serveur de Lumen) : l'erreur s'affiche dans les réglages
      await writeState((s) => void (s.error = `Fin d'installation impossible : ${e.message.split('\n')[0]}`)).catch(() => {})
    })
    .finally(() => (installCheck = null))
  return installCheck
}

/** Fin d'installation : arrêt propre, instantané « propre » du disque, puis démarrage normal (sans les CD). */
function finalize(versions: string, emit: Emit): Promise<void> {
  return once('finalize', async () => {
    if ((await readState()).phase !== 'installing') return // déjà finalisée ailleurs
    busy = 'finalize'
    say(emit)({ status: 'vm-finalize', text: 'Windows est installé : instantané « propre » de la machine…' })
    const pw = await ssh('if exist "C:\\Program Files\\PowerShell\\7\\pwsh.exe" (echo oui) else (echo non)', { timeout: 20_000 })
    await writeState((s) => {
      s.versions = versions || s.versions
      s.pwsh = pw.stdout.toString().includes('oui')
    })
    await shutdown()
    await qemuImg(['snapshot', '-c', SNAPSHOT, F.disk])
    const st = await writeState((s) => {
      s.phase = 'ready'
      s.installedAt = Date.now()
      delete s.error
      delete s.startedAt
    })
    await fs.rm(F.unattend, { force: true })
    busy = 'start'
    say(emit)({ status: 'vm-boot', text: 'Démarrage de Windows…' })
    await launch('normal', st)
    await waitSsh(emit)
  })
}

async function waitSsh(emit: Emit, limitMs = 6 * 60_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    if (await sshOk()) return
    if (!pidAlive()) {
      const tail = (await fs.readFile(F.log, 'utf8').catch(() => '')).trim().split('\n').slice(-6).join('\n')
      throw new Error(`La machine Windows s'est arrêtée au démarrage.${tail ? `\n${tail}` : ''}`)
    }
    say(emit)({ status: 'vm-boot', text: `Démarrage de Windows… ${Math.round((Date.now() - t0) / 1000)} s` })
    await sleep(3000)
  }
  throw new Error("Windows ne répond pas (SSH). Regardez son écran (bouton « Écran ») ou redémarrez la machine.")
}

/** Arrêt propre de Windows (SSH, puis bouton d'alimentation virtuel), forcé au bout de 2 min. */
async function shutdown() {
  if (!pidAlive()) return
  await ssh('shutdown /s /t 0 /f', { timeout: 15_000 })
  for (let i = 0; i < 90 && pidAlive(); i++) await sleep(1000)
  if (!pidAlive()) return
  await qmp([{ execute: 'system_powerdown' }], 5000).catch(() => {})
  for (let i = 0; i < 30 && pidAlive(); i++) await sleep(1000)
  if (!pidAlive()) return
  await qmp([{ execute: 'quit' }], 5000).catch(() => {})
  await sleep(2000)
  const pid = pidAlive()
  if (pid) process.kill(pid, 'SIGKILL')
}

/** Prépare la machine : installation complète la première fois (≈ 15 min), sinon démarrage. */
export function prepareVm(emitRaw: Emit = noop): Promise<void> {
  const emit = say(emitRaw)
  return once('prepare', async () => {
    if (!vmSupported()) throw new Error('Le labo Windows complet fonctionne sur Mac à processeur Apple (M1 ou plus récent).')
    if (!(await qemuInfo())) throw new Error(NO_QEMU)
    let st = await readState()
    if (st.phase === 'ready') return startVm(emitRaw)
    if (!st.license) throw new Error('windows-license')
    const iso = findIso(st.iso)
    if (!iso) throw new Error('windows-iso')
    if (!(st.phase === 'installing' && pidAlive())) {
      busy = 'prepare'
      const fresh = st.phase !== 'installing' || !existsSync(F.disk) || !existsSync(F.unattend)
      if (fresh) {
        emit({ status: 'vm-iso', text: `Vérification de ${path.basename(iso)}…` })
        const { lang } = await inspectIso(iso)
        await fs.mkdir(VM_DIR, { recursive: true, mode: 0o700 })
        await ensureDrivers(emit)
        await ensureKey()
        st = await writeState((s) => {
          s.iso = iso
          s.lang = lang
          s.password ??= randomBytes(12).toString('base64url')
        })
        emit({ status: 'vm-iso', text: "Préparation du CD d'installation…" })
        await buildUnattend(st)
        await fs.rm(F.disk, { force: true })
        await qemuImg(['create', '-q', '-f', 'qcow2', F.disk, DISK_SIZE])
        const fw = firmware(qemuBin()!)!
        await fs.copyFile(fw.vars, F.vars)
        st = await writeState((s) => {
          s.phase = 'installing'
          s.startedAt = Date.now()
          delete s.error
        })
      } else {
        await writeState((s) => void delete s.error)
      }
      emit({ status: 'vm-install', text: 'Démarrage de l’installation…' })
      await launch('install', st)
      if (fresh) void pressKeyToBoot()
    }
    busy = 'install'
    if (st.error?.startsWith("Fin d'installation")) await writeState((s) => void delete s.error) // nouvel essai
    // Délai maximal compté en tours d'attente (≈ 20 s chacun) : pendant la veille du Mac, la machine est suspendue
    // et la boucle aussi, alors que l'horloge (Date.now, performance.now) continue d'avancer.
    let rounds = 0
    for (;;) {
      st = await readState()
      if (st.phase === 'ready') return
      emit({ status: 'vm-install', text: `Installation de Windows · ${minutesSince(st.startedAt)} min (≈ 15 min)` })
      await checkInstall(true)
      st = await readState()
      if (st.phase === 'ready') return
      if (st.error?.startsWith("Fin d'installation")) throw new Error(st.error)
      if (!pidAlive() && !inflight.has('finalize') && !locked('finalize')) throw new Error(st.error ?? "La machine s'est arrêtée pendant l'installation.")
      if (++rounds > 450) throw new Error("L'installation dure depuis plus de 2 h 30 : regardez l'écran du labo (bouton « Écran »).")
      await sleep(15_000)
    }
  })
}

/** Démarre la machine installée et attend que Windows réponde (SSH). */
export function startVm(emit: Emit = noop): Promise<void> {
  return once('start', async () => {
    let st = await readState()
    if (st.phase === 'installing') {
      await checkInstall(true) // l'installation vient peut-être de se terminer : on la finalise
      st = await readState()
    }
    if (st.phase !== 'ready') {
      if (st.phase === 'installing') throw new Error(`Le labo Windows complet est en cours d'installation (${minutesSince(st.startedAt)} min sur ≈ 15) : réessaie un peu plus tard.`)
      throw new Error(NOT_INSTALLED)
    }
    if (!pidAlive()) {
      busy = 'start'
      say(emit)({ status: 'vm-boot', text: 'Démarrage de Windows…' })
      await launch('normal', st)
    }
    busy = busy ?? 'start'
    await waitSsh(emit)
  })
}

/** Avant chaque outil de l'agent : machine démarrée et joignable (vérifié au plus toutes les 20 s). */
export async function ensureVm(emit: Emit = noop) {
  if (pidAlive() && Date.now() - sshOkAt < 20_000) return
  if (pidAlive() && (await sshOk())) return
  await startVm(emit)
}

export function stopVm(): Promise<void> {
  return once('stop', async () => {
    busy = 'stop'
    progress = 'Arrêt de Windows…'
    await shutdown()
  })
}

/** Machine neuve : retour à l'instantané pris juste après l'installation (les fichiers de « Lumen Labo » restent). */
export function resetVm(): Promise<void> {
  return once('reset', async () => {
    const st = await readState()
    if (st.phase !== 'ready') throw new Error(NOT_INSTALLED)
    busy = 'reset'
    progress = 'Retour à la machine neuve…'
    await shutdown()
    await qemuImg(['snapshot', '-a', SNAPSHOT, F.disk])
  })
}

/** Supprime la machine (disque, NVRAM, état) pour libérer la place ; l'accord de licence et les pilotes restent. */
export function deleteVm(): Promise<void> {
  return once('delete', async () => {
    busy = 'delete'
    progress = 'Suppression de la machine…'
    const pid = pidAlive()
    if (pid) {
      await qmp([{ execute: 'quit' }], 5000).catch(() => process.kill(pid, 'SIGKILL'))
      for (let i = 0; i < 20 && pidAlive(); i++) await sleep(250)
    }
    for (const f of [F.disk, F.vars, F.unattend, F.log, F.pid, QMP_SOCK]) await fs.rm(f, { force: true })
    await writeState((s) => {
      for (const k of ['phase', 'startedAt', 'installedAt', 'versions', 'pwsh', 'error', 'password'] as const) delete s[k]
    })
  })
}

// ---------- Outils de l'agent ----------
/** Chemin Windows : relatif = C:\labo ; « / » accepté ; « ~ » = dossier de l'utilisateur lumen. */
export function winPath(p: string): string {
  let x = (p || '').trim().replace(/^["']|["']$/g, '').replace(/\//g, '\\')
  if (!x || x === '.') return 'C:\\labo'
  if (/^[a-z]:(\\|$)/i.test(x)) return x.length === 2 ? `${x}\\` : x
  if (x === '~' || x.startsWith('~\\')) return `C:\\Users\\${USER}${x.slice(1)}`
  if (/^\\workspace(\\|$)/i.test(x)) x = x.slice(10).replace(/^\\/, '') // habitude des autres labos
  else if (x.startsWith('\\')) return `C:${x}`
  return x ? `C:\\labo\\${x}` : 'C:\\labo'
}

/** Copie sur l'ordinateur (~/Lumen Labo/windows-vm) d'un fichier de C:\labo. */
function hostMirror(p: string): string | null {
  const m = p.match(/^c:\\labo(?:\\(.*))?$/i)
  if (!m) return null
  return path.join(WORK, ...(m[1] ?? '').split('\\').filter((s) => s && s !== '..'))
}

/** Copie un fichier ou un dossier de la machine (C:\labo…) vers l'ordinateur (compilateur .exe de l'agent). */
export async function vmCopyOut(src: string, dest: string): Promise<{ ok: boolean; output: string }> {
  await ensureVm()
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const r = await exec('scp', ['-r', '-q', ...sshArgs().map((x) => (x === '-p' ? '-P' : x)), `${USER}@127.0.0.1:${winPath(src).replace(/\\/g, '/')}`, dest], {
    timeout: 15 * 60_000,
  })
  return { ok: r.code === 0, output: r.out.trim() }
}

function decodeText(b: Buffer): string | null {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le')
  if (b.includes(0)) return null
  return b.toString('utf8').replace(/^\ufeff/, '')
}

export async function vmScreen(): Promise<Buffer | null> {
  if (!pidAlive()) return null
  const file = path.join(os.tmpdir(), `lumen-vm-${process.pid}-${randomBytes(4).toString('hex')}.png`)
  try {
    await qmp([{ execute: 'screendump', arguments: { filename: file, format: 'png' } }], 15_000)
    return await fs.readFile(file)
  } catch {
    return null
  } finally {
    await fs.rm(file, { force: true })
  }
}

const pngSize = (b: Buffer) => (b.length > 24 ? `${b.readUInt32BE(16)} × ${b.readUInt32BE(20)}` : '?')

export async function vmTool(name: string, a: Record<string, unknown>, cwd: string, emit: Emit, shrink: (png: Buffer, max: number) => Promise<Buffer>): Promise<ToolResult> {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  await ensureVm(emit)
  switch (name) {
    case 'lab_run': {
      const command = str('command')
      if (!command.trim()) return { ok: false, output: 'Paramètre « command » manquant.' }
      const t = Math.min(1800, Math.max(5, Number(a.timeout) || 300))
      const dir = winPath(str('cwd'))
      const id = randomBytes(6).toString('hex')
      const pidFile = `C:\\lumen\\run-${id}.pid`
      // Le script arrive par l'entrée standard (aucune limite de longueur) ; erreurs et sortie dans l'ordre.
      // Code de sortie : celui du dernier programme, sinon 1 si une erreur PowerShell non traitée s'est affichée
      // (les erreurs captées par try/catch ou -ErrorAction SilentlyContinue, et le stderr des programmes, ne comptent pas).
      const boot =
        `New-Item -ItemType Directory -Force -Path C:\\labo,C:\\lumen|Out-Null;[IO.File]::WriteAllText(${psq(pidFile)},\"$PID\");` +
        `try{Set-Location -LiteralPath ${psq(dir)} -ErrorAction Stop}catch{Write-Output ('Dossier introuvable dans la machine : '+${psq(dir)});exit 1};` +
        `$s=[Console]::In.ReadToEnd();$global:__e=0;$global:LASTEXITCODE=0;` +
        // Tous les flux dans l'ordre (*>&1), erreurs converties en texte (sinon pwsh les écrit en CLIXML sur stderr)
        `try{. ([scriptblock]::Create($s)) *>&1|ForEach-Object{if($_ -is [Management.Automation.ErrorRecord]){if($_.FullyQualifiedErrorId -like 'NativeCommandError*'){\"$_\"}else{$global:__e++;($_|Out-String).TrimEnd()}}elseif($_ -is [Management.Automation.WarningRecord]){'AVERTISSEMENT : '+$_.Message}else{$_}}|Out-Host}` +
        `catch{Write-Output (($_|Out-String).TrimEnd());exit 1}` +
        `finally{Remove-Item -LiteralPath ${psq(pidFile)} -ErrorAction SilentlyContinue};` +
        `if($global:LASTEXITCODE){exit $global:LASTEXITCODE};if($global:__e){exit 1};exit 0`
      const r = await ps(boot, { input: command, timeout: (t + 15) * 1000 })
      const code = r.timedOut ? 124 : r.code
      // Délai dépassé : la session SSH est coupée, mais les programmes lancés continueraient dans Windows → on les arrête
      if (r.timedOut) await ssh(`for /f %p in (${pidFile}) do taskkill /T /F /PID %p & del /q ${pidFile}`, { timeout: 20_000 })
      const note = code === 124 ? `\n[arrêtée : plus de ${t} s. Programmes graphiques : « lumen-gui prog.exe » ; serveurs : « Start-Process … »]` : ''
      return { ok: code === 0, output: `${clip(r.out.trim() || '(aucune sortie)')}${note}\n[Windows (VM) · code de sortie : ${code}]` }
    }
    case 'lab_write_file': {
      if (!str('path')) return { ok: false, output: 'Paramètre « path » manquant.' }
      const p = winPath(str('path'))
      const content = typeof a.content === 'string' ? a.content : ''
      const r = await ps(
        `$p=${psq(p)};$d=Split-Path -Parent $p;if($d){New-Item -ItemType Directory -Force -Path $d|Out-Null};` +
          `$i=[Console]::OpenStandardInput();$f=[IO.File]::Create($p);$i.CopyTo($f);$f.Close();(Get-Item -LiteralPath $p).Length`,
        { input: content, timeout: 120_000 },
      )
      if (r.code !== 0) return { ok: false, output: r.out.trim() || `Écriture impossible : ${p}` }
      const host = hostMirror(p)
      if (host) {
        await fs.mkdir(path.dirname(host), { recursive: true })
        await fs.writeFile(host, content)
      }
      return { ok: true, output: `Écrit dans Windows (VM) : ${p} (${Buffer.byteLength(content)} octets)${host ? `\nCopie sur l'ordinateur : ${host}` : ''}` }
    }
    case 'lab_read_file': {
      const p = winPath(str('path'))
      const r = await ps(
        `$p=${psq(p)};if(Test-Path -LiteralPath $p -PathType Container){Get-ChildItem -Force -LiteralPath $p|Format-Table -AutoSize Mode,LastWriteTime,Length,Name|Out-String -Width 200;exit 3};` +
          `if(-not(Test-Path -LiteralPath $p)){[Console]::Error.WriteLine('Fichier introuvable : '+$p);exit 2};` +
          `$b=[IO.File]::ReadAllBytes($p);$o=[Console]::OpenStandardOutput();$o.Write($b,0,[Math]::Min($b.Length,200000));$o.Flush()`,
        { timeout: 60_000, maxText: 400_000 },
      )
      if (r.code === 3) return { ok: true, output: `${p} est un dossier :\n${clip(r.out.trim())}` }
      if (r.code !== 0) return { ok: false, output: r.out.trim() || `Lecture impossible : ${p}` }
      const text = decodeText(r.stdout)
      if (text === null) return { ok: false, output: `${p} est un fichier binaire (${r.stdout.length} octets lus).` }
      return { ok: true, output: text + (r.stdout.length >= 200_000 ? '\n… (fichier tronqué)' : '') }
    }
    case 'lab_screenshot': {
      const png = await vmScreen()
      if (!png) return { ok: false, output: "Capture impossible : l'écran de la machine ne répond pas." }
      const size = pngSize(png)
      const small = await shrink(png, 1280)
      return { ok: true, output: `Capture de l'écran de Windows (VM, ${size}).`, image: `data:image/png;base64,${small.toString('base64')}` }
    }
    case 'lab_copy_in': {
      const raw = str('source').trim()
      if (!raw) return { ok: false, output: 'Paramètre « source » manquant.' }
      const src = path.resolve(cwd, raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw)
      if (!existsSync(src)) return { ok: false, output: `Introuvable sur l'ordinateur : ${src}` }
      const dest = winPath(str('dest') || path.basename(src))
      // La destination est remplacée : seulement dans C:\labo ou le dossier de l'utilisateur (jamais le système)
      if (!/^c:\\(labo|users\\lumen)\\[^\\]/i.test(dest))
        return { ok: false, output: `Destination refusée : ${dest}. Copiez dans C:\\labo (chemin relatif) ou dans C:\\Users\\lumen\\….` }
      await ps(`$d=${psq(dest)};New-Item -ItemType Directory -Force -Path (Split-Path -Parent $d)|Out-Null;Remove-Item -Recurse -Force -LiteralPath $d -ErrorAction SilentlyContinue`, { timeout: 60_000 })
      const r = await exec('scp', ['-r', '-q', ...sshArgs().map((x) => (x === '-p' ? '-P' : x)), src, `${USER}@127.0.0.1:${dest.replace(/\\/g, '/')}`], { timeout: 15 * 60_000 })
      if (r.code !== 0) return { ok: false, output: r.out.trim() || 'Copie impossible.' }
      return { ok: true, output: `Copié dans Windows (VM) : ${src} → ${dest}` }
    }
    default:
      return { ok: false, output: `Outil inconnu : ${name}` }
  }
}

// ---------- Écran en direct : souris et clavier (panneau « Écran du labo ») ----------
export type ScreenInput = {
  type: 'click' | 'scroll' | 'key'
  x?: number
  y?: number
  px?: number
  py?: number
  button?: 'left' | 'right' | 'middle'
  double?: boolean
  dy?: number
  code?: string
  key?: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

/** Valide un événement reçu du navigateur (types et bornes) ; null s'il est invalide. */
export function parseScreenInput(b: Record<string, unknown>): ScreenInput | null {
  if (b.type !== 'click' && b.type !== 'scroll' && b.type !== 'key') return null
  const num = (k: string) => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? (b[k] as number) : undefined)
  const txt = (k: string) => (typeof b[k] === 'string' && (b[k] as string).length <= 32 ? (b[k] as string) : undefined)
  const bool = (k: string) => b[k] === true
  const button = b.button === 'right' || b.button === 'middle' ? b.button : 'left'
  return {
    type: b.type, x: num('x'), y: num('y'), px: num('px'), py: num('py'), button, double: bool('double'), dy: num('dy'),
    code: txt('code'), key: txt('key'), ctrl: bool('ctrl'), alt: bool('alt'), shift: bool('shift'), meta: bool('meta'),
  }
}

/** KeyboardEvent.code (touche physique) → code QEMU : la disposition (AZERTY…) est appliquée par Windows. */
function qcode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase()
  if (/^Numpad\d$/.test(code)) return `kp_${code.slice(6)}`
  const map: Record<string, string> = {
    Enter: 'ret', NumpadEnter: 'kp_enter', Backspace: 'backspace', Tab: 'tab', Escape: 'esc', Space: 'spc', Delete: 'delete', Insert: 'insert',
    Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Minus: 'minus', Equal: 'equal', BracketLeft: 'bracket_left', BracketRight: 'bracket_right', Backslash: 'backslash', Semicolon: 'semicolon',
    Quote: 'apostrophe', Backquote: 'grave_accent', Comma: 'comma', Period: 'dot', Slash: 'slash', IntlBackslash: 'less', CapsLock: 'caps_lock',
    NumpadAdd: 'kp_add', NumpadSubtract: 'kp_subtract', NumpadMultiply: 'kp_multiply', NumpadDivide: 'kp_divide', NumpadDecimal: 'kp_decimal',
    ShiftLeft: 'shift', ShiftRight: 'shift_r', ControlLeft: 'ctrl', ControlRight: 'ctrl_r', AltLeft: 'alt', AltRight: 'alt_r',
    MetaLeft: 'meta_l', MetaRight: 'meta_r', ContextMenu: 'menu', PrintScreen: 'print',
  }
  return map[code] ?? null
}

export async function vmInput(ev: ScreenInput): Promise<void> {
  if (!pidAlive()) throw new Error('La machine Windows est arrêtée.')
  const abs = (v: number | undefined) => Math.round(Math.min(1, Math.max(0, v ?? 0)) * 32767)
  const move = [
    { type: 'abs', data: { axis: 'x', value: abs(ev.x) } },
    { type: 'abs', data: { axis: 'y', value: abs(ev.y) } },
  ]
  const btn = (button: string, down: boolean) => ({ execute: 'input-send-event', arguments: { events: [{ type: 'btn', data: { down, button } }] } })
  if (ev.type === 'click') {
    const b = ev.button ?? 'left'
    const cmds: QmpCmd[] = [{ execute: 'input-send-event', arguments: { events: move } }]
    for (let i = 0; i < (ev.double ? 2 : 1); i++) cmds.push(btn(b, true), btn(b, false))
    await qmp(cmds)
  } else if (ev.type === 'scroll') {
    const b = (ev.dy ?? 0) < 0 ? 'wheel-up' : 'wheel-down'
    const n = Math.min(10, Math.max(1, Math.round(Math.abs(ev.dy ?? 1))))
    const cmds: QmpCmd[] = [{ execute: 'input-send-event', arguments: { events: move } }]
    for (let i = 0; i < n; i++) cmds.push(btn(b, true), btn(b, false))
    await qmp(cmds)
  } else if (ev.type === 'key') {
    const main = qcode(ev.code ?? '')
    if (!main) return
    // Cmd du Mac = Ctrl de Windows (copier, coller…) ; Option + caractère = AltGr (@, #, {, [, |…) ; Option + autre touche = Alt
    const printable = typeof ev.key === 'string' && [...ev.key].length === 1
    const alt = ev.alt ? (printable && !ev.ctrl && !ev.meta ? 'alt_r' : 'alt') : ''
    const mods = [ev.ctrl || ev.meta ? 'ctrl' : '', alt, ev.shift ? 'shift' : ''].filter((m) => m && m !== main)
    // Appui court (30 ms) : deux lettres identiques tapées vite restent deux lettres
    await qmp([{ execute: 'send-key', arguments: { keys: [...mods, main].map((data) => ({ type: 'qcode', data })), 'hold-time': 30 } }])
  }
}

// ---------- État et actions (Réglages → Labos) ----------
export type VmStatus = {
  supported: boolean
  qemu: string | null
  iso: { path: string; size: number } | null
  isoPage: string
  license: boolean
  phase: 'none' | 'installing' | 'ready'
  state: 'off' | 'booting' | 'on'
  busy: string | null
  progress: string | null
  minutes: number
  error: string | null
  versions: string | null
  disk: number
  network: boolean
  window: boolean
  ssh: string
  ports: string
  workspace: string
}

let sshProbe: Promise<boolean> | null = null
export async function vmStatus(): Promise<VmStatus> {
  const st = await readState()
  const iso = findIso(st.iso)
  let disk = 0
  for (const f of [F.disk, F.vars]) {
    try {
      disk += statSync(f).blocks * 512
    } catch {
      /* absent */
    }
  }
  const alive = !!pidAlive()
  if (st.phase === 'installing') void checkInstall() // reprend le suivi après un redémarrage de Lumen
  let on = alive && Date.now() - sshOkAt < 10_000
  if (alive && !on && st.phase === 'ready' && !busy) {
    sshProbe ??= sshOk().finally(() => (sshProbe = null))
    on = await sshProbe
  }
  return {
    supported: vmSupported(),
    qemu: await qemuInfo(),
    iso: iso ? { path: iso, size: statSync(iso).size } : null,
    isoPage: WINDOWS_ISO_PAGE,
    license: !!st.license,
    phase: st.phase ?? 'none',
    state: !alive ? 'off' : on ? 'on' : 'booting',
    busy,
    progress: progress ?? (st.phase === 'installing' && alive ? `Installation de Windows · ${minutesSince(st.startedAt)} min (≈ 15 min)` : null),
    minutes: minutesSince(st.startedAt),
    error: st.error ?? null,
    versions: st.versions ?? null,
    disk,
    network: st.network !== false,
    window: !!st.window,
    ssh: `127.0.0.1:${VM_SSH_PORT}`,
    ports: `127.0.0.1:${VM_PORT_BASE}–${VM_PORT_BASE + 4}`,
    workspace: WORK,
  }
}

/** Fenêtre « Choisir… » de macOS pour désigner l'ISO de Windows 11 ARM64 déjà téléchargée. */
async function pickIso(): Promise<void> {
  const r = await exec(
    'osascript',
    ['-e', `POSIX path of (choose file with prompt "Choisissez l'ISO de Windows 11 ARM64 (Arm64)" of type {"iso", "public.iso-image"} default location (path to downloads folder))`],
    { timeout: 10 * 60_000 },
  )
  const p = r.stdout.toString().trim()
  if (r.code !== 0 || !p) return // annulé
  if (statSync(p).size < 3e9) throw new Error(`${path.basename(p)} est trop petit pour une ISO de Windows 11.`)
  await writeState((s) => void (s.iso = p))
}

export async function vmAction(action: string, value: unknown, emit: Emit): Promise<void> {
  switch (action) {
    case 'prepare':
      return prepareVm(emit)
    case 'stop':
      return stopVm()
    case 'reset':
      return resetVm()
    case 'vm-delete':
      return deleteVm()
    case 'windows-license':
      await writeState((s) => void (s.license = new Date().toISOString()))
      return
    case 'vm-iso':
      return pickIso()
    case 'vm-window':
      await writeState((s) => void (s.window = !!value))
      return
    case 'network': {
      const on = !!value
      const st = await writeState((s) => void (s.network = on))
      // Le réseau de QEMU se choisit au démarrage : machine installée et allumée → redémarrage
      if (st.phase === 'ready' && pidAlive()) {
        await stopVm()
        await startVm(emit)
      }
      return
    }
    case 'reveal': {
      await fs.mkdir(WORK, { recursive: true })
      await exec('open', [WORK])
      return
    }
    default:
      throw new Error(`Action inconnue pour Windows (VM) : ${action}`)
  }
}
