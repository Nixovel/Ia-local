// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Labos de Lumen : des machines isolées où l'agent écrit, compile, exécute et teste des programmes sans toucher à
 * l'ordinateur de l'utilisateur.
 *  - Linux : Ubuntu LTS avec Python, Node.js, GCC… (conteneur Docker) ;
 *  - Android : construction d'applications (JDK, Gradle, SDK Android, conteneur x86-64) et téléphone virtuel
 *    (émulateur Android de l'ordinateur, accéléré, avec un appareil dédié « Lumen_Labo »).
 *  - Windows complet (windows-vm) : vraie machine virtuelle Windows 11 ARM (QEMU + hyperviseur du Mac), pilotée
 *    par SSH et QMP — voir agent/winvm.ts.
 *
 * Isolation : un conteneur par labo, sans privilèges, mémoire / processeurs / processus limités ; seul le dossier
 * « ~/Lumen Labo/<labo> » y est partagé (/workspace). Internet s'active ou se coupe à chaud. Le téléphone virtuel est
 * piloté par adb, uniquement sur l'émulateur du labo (jamais sur un vrai téléphone branché).
 * L'écran de chaque labo se regarde et se pilote en direct dans Lumen (labScreen, labInput : panneau « Écran du labo »).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clip, exec, sleep, type Out } from './proc'
import { parseScreenInput, VM_PORT_BASE, vmAction, vmInput, vmScreen, vmStatus, vmTool, type ScreenInput } from './winvm'
export { parseScreenInput }

export type DockerLab = 'linux' | 'android'
export type LabId = DockerLab | 'windows-vm'
export const DOCKER_LABS: DockerLab[] = ['linux', 'android']
export const LAB_IDS: LabId[] = [...DOCKER_LABS, 'windows-vm']
export const isLab = (x: unknown): x is LabId => LAB_IDS.includes(x as LabId)
export type { ScreenInput }
export const LAB_TOOL_NAMES = new Set(['lab_run', 'lab_write_file', 'lab_read_file', 'lab_screenshot', 'lab_copy_in', 'android_adb'])

type ToolResult = { ok: boolean; output: string; image?: string }
export type Emit = (o: Record<string, unknown>) => void
const noop: Emit = () => {}

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
const LAB_DIR = fileURLToPath(new URL('../lab', import.meta.url))
export const WORK_ROOT = path.join(os.homedir(), 'Lumen Labo')
const PREFS_FILE = path.join(WORK_ROOT, '.lumen-labs.json')
const LABEL: Record<LabId, string> = { linux: 'Linux', android: 'Android', 'windows-vm': 'Windows (VM)' }
/** Ports 8000 à 8004 du labo, publiés sur l'ordinateur (127.0.0.1 seulement). */
export const PORT_BASE: Record<LabId, number> = { linux: 18000, android: 20000, 'windows-vm': VM_PORT_BASE }
const ctr = (lab: DockerLab) => `lumen-lab-${lab}`
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// ---------- Préférences (Internet par labo, fenêtre du téléphone, versions installées) ----------
type Prefs = { androidWindow?: boolean; network?: Partial<Record<LabId, boolean>>; versions?: Record<string, string> }

async function readPrefs(): Promise<Prefs> {
  try {
    return JSON.parse(await fs.readFile(PREFS_FILE, 'utf8')) as Prefs
  } catch {
    return {}
  }
}
async function writePrefs(patch: (p: Prefs) => void) {
  const p = await readPrefs()
  patch(p)
  await fs.mkdir(WORK_ROOT, { recursive: true })
  await fs.writeFile(PREFS_FILE, JSON.stringify(p, null, 2))
}

// ---------- Docker ----------
let dockerPath: string | null = null

async function dockerBin(): Promise<string | null> {
  if (dockerPath) return dockerPath
  const home = os.homedir()
  const list = isWin
    ? ['docker', 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe']
    : ['docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker', path.join(home, '.orbstack', 'bin', 'docker'), '/Applications/Docker.app/Contents/Resources/bin/docker', '/usr/bin/docker']
  for (const c of list) {
    if (c !== 'docker' && !existsSync(c)) continue
    if ((await exec(c, ['--version'], { timeout: 8000 })).code === 0) return (dockerPath = c)
  }
  return null
}

async function docker(args: string[], o: Parameters<typeof exec>[2] = {}): Promise<Out> {
  const bin = await dockerBin()
  if (!bin) return { code: -1, out: NO_DOCKER, stdout: Buffer.alloc(0), timedOut: false }
  return exec(bin, args, o)
}

const NO_DOCKER =
  "Les labos ont besoin de Docker (gratuit) : sur Mac « OrbStack » (orbstack.dev) ou « Docker Desktop », sur Windows « Docker Desktop » (docker.com), sur Linux « curl -fsSL https://get.docker.com | sh »."

/** Application Docker à démarrer si le moteur est arrêté (Mac, Windows). */
function dockerApp(): string | null {
  if (isMac)
    return ['/Applications/OrbStack.app', '/Applications/Docker.app', path.join(os.homedir(), 'Applications', 'OrbStack.app'), path.join(os.homedir(), 'Applications', 'Docker.app')].find((p) => existsSync(p)) ?? null
  if (isWin) {
    const p = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
    return existsSync(p) ? p : null
  }
  return null
}

type DockerInfo = { installed: boolean; running: boolean; provider?: string; version?: string; canStart: boolean }

async function dockerInfo(): Promise<DockerInfo> {
  if (!(await dockerBin())) return { installed: false, running: false, canStart: false }
  const r = await docker(['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}'], { timeout: 10_000 })
  if (r.code !== 0) return { installed: true, running: false, canStart: !!dockerApp() }
  const [version, provider] = r.stdout.toString().trim().split('|')
  return { installed: true, running: true, version, provider, canStart: !!dockerApp() }
}

async function ensureDocker(emit: Emit) {
  const info = await dockerInfo()
  if (info.running) return
  if (!info.installed) throw new Error(NO_DOCKER)
  const app = dockerApp()
  if (!app) throw new Error('Docker est installé mais arrêté : démarrez-le (Linux : « sudo systemctl start docker »).')
  emit({ status: 'docker' })
  if (isMac) await exec('open', ['-ga', app], { timeout: 15_000 })
  else spawn(app, [], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    if ((await dockerInfo()).running) return
  }
  throw new Error('Docker ne démarre pas : ouvrez-le depuis vos applications.')
}

// ---------- Images et conteneurs ----------
/** Nom de l'image : change quand la recette du labo change (le labo est alors reconstruit). */
function imageTag(lab: DockerLab): string {
  const h = createHash('sha256')
  const files = [`${lab}.Dockerfile`, 'entrypoint.sh', ...(lab === 'android' ? ['android-create.sh'] : [])]
  for (const f of files) if (existsSync(path.join(LAB_DIR, f))) h.update(readFileSync(path.join(LAB_DIR, f)))
  return `lumen-lab-${lab}:${h.digest('hex').slice(0, 12)}`
}

type Ctr = { running: boolean; image: string; network: boolean; ports: boolean }

async function inspect(lab: DockerLab): Promise<Ctr | null> {
  const r = await docker(['inspect', '--type', 'container', ctr(lab)], { timeout: 10_000 })
  if (r.code !== 0) return null
  try {
    type Info = { State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> }; NetworkSettings?: { Networks?: Record<string, unknown> }; HostConfig?: { PortBindings?: Record<string, unknown> } }
    const j = (JSON.parse(r.stdout.toString()) as Info[])[0]
    return {
      running: !!j.State?.Running,
      image: String(j.Config?.Labels?.['lumen.image'] ?? ''),
      network: !!j.NetworkSettings?.Networks?.bridge,
      ports: Object.keys(j.HostConfig?.PortBindings ?? {}).length > 0,
    }
  } catch {
    return null
  }
}

/** Licences du SDK Android acceptées : celles du SDK de l'ordinateur, sinon celles acceptées dans Lumen. */
const OWN_LICENSES = path.join(os.homedir(), '.lumen', 'android-licenses')
function licensesDir(): string | null {
  const sdk = androidSdk()
  const dirs = [sdk ? path.join(sdk, 'licenses') : '', OWN_LICENSES]
  return dirs.find((d) => d && existsSync(path.join(d, 'android-sdk-license'))) ?? null
}

/** Enregistre l'acceptation de la licence du SDK Android (uniquement après le clic de l'utilisateur dans Lumen). */
export async function acceptAndroidLicense() {
  await fs.mkdir(OWN_LICENSES, { recursive: true })
  await fs.writeFile(path.join(OWN_LICENSES, 'android-sdk-license'), '\n24333f8a63b6825ea9c5514f83c2829b004d1fee')
  await fs.writeFile(path.join(OWN_LICENSES, 'android-sdk-arm-dbt-license'), '\n859f317696f67ef3d7f30a50a5560e7834b43903')
}

const busy = new Map<DockerLab, string>()

async function build(lab: DockerLab, tag: string, emit: Emit, fresh: boolean) {
  const args = ['build', '--progress=plain', '-t', tag, '-f', path.join(LAB_DIR, `${lab}.Dockerfile`)]
  if (lab === 'android') {
    const lic = licensesDir()
    if (!lic) throw new Error('android-license')
    args.push('--build-context', `licenses=${lic}`)
  }
  if (fresh) args.push('--pull', '--no-cache')
  args.push(LAB_DIR)
  busy.set(lab, 'build')
  emit({ status: 'build', step: 0, total: 0 })
  let buf = ''
  const r = await docker(args, {
    timeout: 90 * 60_000,
    maxText: 400_000,
    onData: (s) => {
      buf += s
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const m = line.match(/^#\d+ \[(?:\S+\s+)?(\d+)\/(\d+)\] (.*)$/) // « [3/7] » ou « [stage-0  3/12] »
        if (m) emit({ status: 'build', step: Number(m[1]), total: Number(m[2]), text: m[3].replace(/\s+/g, ' ').slice(0, 90) })
      }
    },
  })
  if (r.code !== 0) {
    const tail = r.out.trim().split('\n').filter((l) => !/^#\d+ (sha256|extracting|DONE|CACHED)/.test(l)).slice(-14).join('\n')
    throw new Error(`Construction du labo ${LABEL[lab]} impossible :\n${tail}`)
  }
}

/** Supprime les anciennes images de ce labo (remplacées par une recette plus récente). */
async function cleanupImages(lab: DockerLab, keep: string) {
  const r = await docker(['images', '--format', '{{.Repository}}:{{.Tag}}', `lumen-lab-${lab}`], { timeout: 15_000 })
  for (const t of r.stdout.toString().split('\n').map((s) => s.trim()))
    if (t && t !== keep && t.startsWith(`lumen-lab-${lab}:`)) await docker(['rmi', t], { timeout: 60_000 })
}

async function create(lab: DockerLab, tag: string, emit: Emit) {
  busy.set(lab, 'create')
  emit({ status: 'create' })
  const ws = path.join(WORK_ROOT, lab)
  await fs.mkdir(ws, { recursive: true })
  const cpus = Math.max(1, Math.min(6, Math.floor(os.cpus().length / 2)))
  const memGB = Math.max(2, Math.min(8, Math.floor(os.totalmem() / 2 ** 30 / 4)))
  const base = [
    'run', '-d', '--name', ctr(lab), '--hostname', `labo-${lab}`, '--label', `lumen.lab=${lab}`, '--label', `lumen.image=${tag}`,
    '--cpus', String(cpus), '--memory', `${memGB}g`, '--pids-limit', '4096', '--security-opt', 'no-new-privileges', '--shm-size', '512m',
    '-v', `${ws}:/workspace`,
    ...(lab === 'android' ? ['-v', 'lumen-lab-android-gradle:/root/.gradle'] : []),
  ]
  const p = PORT_BASE[lab]
  let r = await docker([...base, '-p', `127.0.0.1:${p}-${p + 4}:8000-8004`, tag], { timeout: 120_000 })
  if (r.code !== 0 && /port|address already in use/i.test(r.out)) {
    await docker(['rm', '-f', ctr(lab)], { timeout: 30_000 })
    r = await docker([...base, tag], { timeout: 120_000 }) // ports déjà pris : le labo démarre sans eux
  }
  if (r.code !== 0) throw new Error(`Démarrage du labo ${LABEL[lab]} impossible : ${r.out.trim()}`)
}

const VERSION_CMD: Record<DockerLab, string> = {
  linux: String.raw`. /etc/os-release; printf '%s · Node.js %s · %s · GCC %s' "$PRETTY_NAME" "$(node -v)" "$(python3 -V)" "$(gcc -dumpfullversion)"`,
  android: String.raw`printf 'JDK %s · Gradle %s · SDK %s· build-tools %s' "$(java -version 2>&1 | head -1 | cut -d'"' -f2)" "$(cat /opt/gradle/VERSION 2>/dev/null)" "$(ls $ANDROID_HOME/platforms | tr '\n' ' ')" "$(ls $ANDROID_HOME/build-tools | tr '\n' ' ')"`,
}

const inflight = new Map<DockerLab, Promise<void>>()

/** Prépare le labo si besoin (Docker démarré, image construite, conteneur créé et démarré). */
export function ensureLab(lab: DockerLab, emit: Emit = noop, opts: { rebuild?: boolean } = {}): Promise<void> {
  const cur = inflight.get(lab)
  if (cur) return cur
  const p = (async () => {
    await ensureDocker(emit)
    const tag = imageTag(lab)
    const images = await docker(['images', '-q', tag], { timeout: 15_000 })
    if (opts.rebuild || !images.stdout.toString().trim()) await build(lab, tag, emit, !!opts.rebuild)
    let c = await inspect(lab)
    if (c && (c.image !== tag || opts.rebuild)) {
      await docker(['rm', '-f', ctr(lab)], { timeout: 60_000 }) // recette plus récente : nouveau conteneur, mêmes fichiers
      c = null
    }
    if (!c) {
      await create(lab, tag, emit)
      await cleanupImages(lab, tag)
    } else if (!c.running) {
      busy.set(lab, 'start')
      emit({ status: 'start' })
      const r = await docker(['start', ctr(lab)], { timeout: 60_000 })
      if (r.code !== 0) throw new Error(`Démarrage du labo ${LABEL[lab]} impossible : ${r.out.trim()}`)
    }
    const prefs = await readPrefs()
    if (prefs.network?.[lab] === false) await docker(['network', 'disconnect', 'bridge', ctr(lab)], { timeout: 20_000 })
    if (!prefs.versions?.[tag] || opts.rebuild) {
      const v = await docker(['exec', ctr(lab), 'bash', '-c', VERSION_CMD[lab]], { timeout: 90_000 })
      if (v.code === 0 && v.stdout.toString().trim()) await writePrefs((p) => void (p.versions = { ...p.versions, [tag]: v.stdout.toString().trim() }))
    }
  })().finally(() => {
    inflight.delete(lab)
    busy.delete(lab)
  })
  inflight.set(lab, p)
  return p
}

// ---------- Téléphone virtuel (émulateur Android de l'ordinateur) ----------
const AVD = 'Lumen_Labo'
const EMU_PORT = 5584 // distinct du 5554 d'Android Studio : jamais le téléphone virtuel de l'utilisateur
const SERIAL = `emulator-${EMU_PORT}`

function androidSdk(): string | null {
  const home = os.homedir()
  const list = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    isMac ? path.join(home, 'Library', 'Android', 'sdk') : isWin ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk') : path.join(home, 'Android', 'Sdk'),
    path.join(home, '.lumen', 'android-sdk'),
  ].filter((p): p is string => !!p && existsSync(p))
  return list.find((p) => existsSync(path.join(p, 'emulator'))) ?? list[0] ?? null
}

const sdkTool = (sdk: string, ...rel: string[]) => {
  const p = path.join(sdk, ...rel) + (isWin ? '.exe' : '')
  return existsSync(p) ? p : null
}

type SysImage = { sysdir: string; target: string; tag: string; abi: string; label: string }

/** L'image système la plus récente du SDK, pour le processeur de l'ordinateur (images Google APIs d'abord). */
function systemImage(sdk: string): SysImage | null {
  const root = path.join(sdk, 'system-images')
  if (!existsSync(root)) return null
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
  const num = (s: string) => s.replace(/^android-/, '').split(/[.-]/).map((x) => Number(x) || 0)
  const apis = readdirSync(root)
    .filter((d) => /^android-\d/.test(d))
    .sort((a, b) => {
      const x = num(a)
      const y = num(b)
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
      return 0
    })
  const rank = (t: string) => {
    const i = ['google_apis', 'google_apis_playstore', 'default'].indexOf(t)
    return i < 0 ? 9 : i
  }
  for (const api of apis) {
    const tags = readdirSync(path.join(root, api)).sort((a, b) => rank(a) - rank(b))
    for (const tag of tags)
      if (existsSync(path.join(root, api, tag, abi, 'system.img')))
        return { sysdir: `system-images/${api}/${tag}/${abi}/`, target: api, tag, abi, label: `${api.replace('android-', 'Android API ')} · ${tag.replace(/_/g, ' ')}` }
  }
  return null
}

const avdHome = () => process.env.ANDROID_AVD_HOME || path.join(process.env.ANDROID_USER_HOME || path.join(os.homedir(), '.android'), 'avd')

/** Appareil virtuel dédié au labo (créé une fois) : l'IA ne touche pas aux téléphones virtuels de l'utilisateur. */
async function ensureAvd(img: SysImage) {
  const dir = path.join(avdHome(), `${AVD}.avd`)
  const ini = path.join(avdHome(), `${AVD}.ini`)
  const cfgFile = path.join(dir, 'config.ini')
  if (existsSync(ini) && existsSync(cfgFile) && readFileSync(cfgFile, 'utf8').includes(`image.sysdir.1=${img.sysdir}`)) return
  await fs.mkdir(dir, { recursive: true })
  const cfg = {
    AvdId: AVD, 'avd.ini.displayname': 'Lumen Labo', 'avd.ini.encoding': 'UTF-8',
    'abi.type': img.abi, 'hw.cpu.arch': img.abi === 'arm64-v8a' ? 'arm64' : 'x86_64', 'hw.cpu.ncore': '4',
    'hw.ramSize': '4096', 'vm.heapSize': '512', 'disk.dataPartition.size': '8G',
    'hw.lcd.width': '1080', 'hw.lcd.height': '2400', 'hw.lcd.density': '420',
    'hw.keyboard': 'yes', 'hw.mainKeys': 'no', 'hw.gpu.enabled': 'yes', 'hw.gpu.mode': 'auto', 'hw.audioInput': 'no', 'hw.sdCard': 'no',
    'image.sysdir.1': img.sysdir, 'tag.id': img.tag, 'PlayStore.enabled': String(img.tag.includes('playstore')), target: img.target,
    'fastboot.forceColdBoot': 'no', 'fastboot.forceFastBoot': 'yes', showDeviceFrame: 'no', 'skin.dynamic': 'yes',
  }
  await fs.writeFile(cfgFile, Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  await fs.writeFile(ini, `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${AVD}.avd\ntarget=${img.target}\n`)
}

let emuProc: ChildProcess | null = null
let emuExit: number | null = null

async function adbBin(): Promise<string | null> {
  const sdk = androidSdk()
  return (sdk && sdkTool(sdk, 'platform-tools', 'adb')) || null
}

type Device = 'off' | 'booting' | 'on'
async function deviceState(): Promise<Device> {
  const adb = await adbBin()
  if (!adb) return 'off'
  const r = await exec(adb, ['-s', SERIAL, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 6000 })
  if (r.code === 0 && r.stdout.toString().trim() === '1') return 'on'
  return r.code === 0 || (emuProc && emuExit === null) ? 'booting' : 'off'
}

const NO_EMULATOR =
  "Pas de téléphone virtuel : installez Android Studio (developer.android.com/studio), puis dans « Device Manager » un téléphone récent (cela installe l'émulateur et une image système)."

let emuStarting: Promise<void> | null = null

/** Démarre le téléphone virtuel du labo s'il ne tourne pas, et attend qu'Android ait fini de démarrer. */
export function ensureEmulator(emit: Emit = noop): Promise<void> {
  emuStarting ??= (async () => {
    const sdk = androidSdk()
    const emu = sdk && sdkTool(sdk, 'emulator', 'emulator')
    const adb = await adbBin()
    const img = sdk ? systemImage(sdk) : null
    if (!sdk || !emu || !adb || !img) throw new Error(NO_EMULATOR)
    if ((await deviceState()) === 'on') return
    await ensureAvd(img)
    if ((await deviceState()) === 'off') {
      emit({ status: 'emulator' })
      await exec(adb, ['start-server'], { timeout: 20_000 })
      await fs.mkdir(WORK_ROOT, { recursive: true })
      const log = await fs.open(path.join(WORK_ROOT, '.emulateur.log'), 'w')
      const window = !!(await readPrefs()).androidWindow
      emuExit = null
      emuProc = spawn(
        emu,
        ['-avd', AVD, '-port', String(EMU_PORT), '-no-boot-anim', '-no-audio', '-netdelay', 'none', '-netspeed', 'full', ...(window ? [] : ['-no-window', '-gpu', 'swiftshader_indirect'])],
        { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: !window, env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } },
      )
      emuProc.on('exit', (code) => (emuExit = code ?? -1))
      emuProc.unref()
      await log.close()
    }
    for (let i = 0; i < 360; i++) {
      if ((await deviceState()) === 'on') {
        // Animations coupées (tests plus rapides et fiables) et écran déverrouillé
        await exec(adb, ['-s', SERIAL, 'shell', 'settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0; input keyevent 82'], { timeout: 20_000 })
        return
      }
      if (emuExit !== null) break
      await sleep(1000)
    }
    const log = await fs.readFile(path.join(WORK_ROOT, '.emulateur.log'), 'utf8').catch(() => '')
    throw new Error(`Le téléphone virtuel ne démarre pas.${log ? `\n${log.trim().split('\n').slice(-8).join('\n')}` : ''}`)
  })().finally(() => {
    emuStarting = null
  })
  return emuStarting
}

async function stopEmulator() {
  const adb = await adbBin()
  if (adb) await exec(adb, ['-s', SERIAL, 'emu', 'kill'], { timeout: 15_000 })
}

/** Découpe une ligne de commande (guillemets simples et doubles). */
function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  let any = false
  for (const ch of s.trim()) {
    if (q) {
      if (ch === q) q = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      q = ch
      any = true
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

const ADB_ALLOWED = new Set(['install', 'install-multiple', 'uninstall', 'shell', 'logcat', 'push', 'pull', 'devices', 'get-state', 'reboot'])

async function androidAdb(raw: string, emit: Emit): Promise<ToolResult> {
  const line = raw.trim().replace(/^adb\s+/, '').replace(/^-s\s+\S+\s+/, '')
  const sub = line.split(/\s+/)[0] ?? ''
  if (!ADB_ALLOWED.has(sub))
    return { ok: false, output: `Commande adb non autorisée : « ${sub || '(vide)'} ». Autorisées : ${[...ADB_ALLOWED].join(', ')}.` }
  const ws = path.join(WORK_ROOT, 'android')
  // Fichiers de l'ordinateur : uniquement dans le dossier du labo Android (chemins relatifs = /workspace)
  const local = (p: string) => {
    const lp = labPath('android', p)
    if (lp !== '/workspace' && !lp.startsWith('/workspace/')) throw new Error(`Chemin hors du labo : ${p} (utilisez un chemin dans /workspace).`)
    return path.join(ws, path.posix.relative('/workspace', lp))
  }
  let args: string[]
  try {
    if (sub === 'shell') args = ['shell', line.slice(5).trim()]
    else {
      args = splitArgs(line)
      if (sub === 'install' || sub === 'install-multiple') args = args.map((a, i) => (i > 0 && !a.startsWith('-') ? local(a) : a))
      if (sub === 'push' && args.length >= 3) args[args.length - 2] = local(args[args.length - 2])
      if (sub === 'pull') args = args.length >= 3 ? [...args.slice(0, -1), local(args[args.length - 1])] : [...args, ws]
      if (sub === 'logcat' && !args.includes('-d')) args.splice(1, 0, '-d') // jamais en continu
      if (sub === 'logcat' && !args.includes('-t')) args.splice(2, 0, '-t', '400')
    }
  } catch (e) {
    return { ok: false, output: (e as Error).message }
  }
  await ensureEmulator(emit)
  const adb = (await adbBin())!
  const r = await exec(adb, ['-s', SERIAL, ...args], { timeout: sub === 'install' || sub === 'install-multiple' ? 300_000 : 120_000 })
  const out = r.out.trim().replaceAll(ws, '/workspace')
  return { ok: r.code === 0 && !/^(Failure|Error|adb: error)/m.test(out), output: `${clip(out || '(aucune sortie)')}\n[téléphone virtuel · code de sortie : ${r.code}]` }
}

// ---------- Outils de l'agent ----------
/** Chemin dans le labo : relatif à /workspace ; « ~ » = /root. */
function labPath(_lab: DockerLab, p: string): string {
  let x = (p || '').trim().replace(/^["']|["']$/g, '')
  if (!x || x === '.') return '/workspace'
  if (x === '~' || x.startsWith('~/')) x = '/root' + x.slice(1)
  return x.startsWith('/') ? path.posix.normalize(x) : path.posix.join('/workspace', x)
}

/** Où se trouve, sur l'ordinateur, un fichier du dossier partagé /workspace. */
function hostPath(lab: LabId, p: string): string | null {
  if (p !== '/workspace' && !p.startsWith('/workspace/')) return null
  return path.join(WORK_ROOT, lab, path.posix.relative('/workspace', p))
}

async function resizePng(buf: Buffer, max: number): Promise<Buffer> {
  if (!isMac) return buf
  const file = path.join(os.tmpdir(), `lumen-labo-${Date.now()}.png`)
  await fs.writeFile(file, buf)
  await exec('sips', ['-Z', String(max), file], { timeout: 20_000 })
  const out = await fs.readFile(file)
  await fs.rm(file, { force: true })
  return out
}

const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
/** Capture de l'écran virtuel (Xvfb :99) du labo Linux. */
const SCREEN_CMD = 'import -display :99 -window root png:- 2>/dev/null || magick import -display :99 -window root png:- 2>/dev/null || xwd -display :99 -root -silent | convert xwd:- png:-'

// ---------- Écran en direct (panneau « Écran du labo » de Lumen) ----------
/** Image PNG de l'écran d'un labo déjà allumé (null s'il est éteint : on ne démarre rien pour regarder). */
export async function labScreen(lab: LabId): Promise<Buffer | null> {
  if (lab === 'windows-vm') return vmScreen()
  if (lab === 'android') {
    const adb = await adbBin()
    if (!adb || (await deviceState()) !== 'on') return null
    const r = await exec(adb, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { timeout: 20_000, maxText: 1000 })
    return isPng(r.stdout) ? r.stdout : null
  }
  if (!(await inspect(lab))?.running) return null
  const r = await docker(['exec', ctr(lab), 'sh', '-c', SCREEN_CMD], { timeout: 20_000, maxText: 1000 })
  return isPng(r.stdout) ? r.stdout : null
}

const XDO_KEYS: Record<string, string> = {
  Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Prior',
  PageDown: 'Next', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'space',
}
const ADB_KEYS: Record<string, number> = { Enter: 66, Backspace: 67, Escape: 4, Tab: 61, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Delete: 112, Home: 122, End: 123 }

/** Clic, molette ou touche envoyés à l'écran d'un labo allumé (coordonnées en pixels de la capture). */
export async function labInput(lab: LabId, ev: ScreenInput): Promise<void> {
  if (lab === 'windows-vm') return vmInput(ev)
  const px = Math.max(0, Math.round(ev.px ?? 0))
  const py = Math.max(0, Math.round(ev.py ?? 0))
  if (lab === 'android') {
    const adb = await adbBin()
    if (!adb || (await deviceState()) !== 'on') throw new Error('Le téléphone virtuel est éteint.')
    const sh = (cmd: string) => exec(adb, ['-s', SERIAL, 'shell', cmd], { timeout: 15_000 })
    if (ev.type === 'click') await sh(ev.button === 'right' ? 'input keyevent 4' : `input tap ${px} ${py}`)
    else if (ev.type === 'scroll') await sh(`input swipe ${px} ${py} ${px} ${Math.max(0, py - Math.round((ev.dy ?? 1) * 300))} 200`)
    else if (ev.type === 'key') {
      const k = ADB_KEYS[ev.key ?? '']
      if (k) await sh(`input keyevent ${k}`)
      else if (ev.key && [...ev.key].length === 1 && !ev.ctrl && !ev.meta) await sh(`input text ${shq(ev.key === ' ' ? '%s' : ev.key)}`)
    }
    return
  }
  if (!(await inspect(lab))?.running) throw new Error(`Le labo ${LABEL[lab]} est arrêté.`)
  const xdo = (...args: string[]) => docker(['exec', '-e', 'DISPLAY=:99', ctr(lab), 'xdotool', ...args], { timeout: 15_000 })
  const btn = ev.button === 'right' ? '3' : ev.button === 'middle' ? '2' : '1'
  if (ev.type === 'click') await xdo('mousemove', String(px), String(py), 'click', ...(ev.double ? ['--repeat', '2'] : []), btn)
  else if (ev.type === 'scroll') await xdo('mousemove', String(px), String(py), 'click', '--repeat', String(Math.min(10, Math.max(1, Math.round(Math.abs(ev.dy ?? 1))))), (ev.dy ?? 0) < 0 ? '4' : '5')
  else if (ev.type === 'key' && ev.key) {
    const mods = [ev.ctrl || ev.meta ? 'ctrl' : '', ev.alt ? 'alt' : ''].filter(Boolean)
    const named = XDO_KEYS[ev.key] ?? (/^F\d{1,2}$/.test(ev.key) ? ev.key : null)
    if (named || mods.length) await xdo('key', '--', [...mods, named ?? ev.key.toLowerCase()].join('+'))
    else if ([...ev.key].length === 1) await xdo('type', '--', ev.key)
  }
}

export async function labTool(name: string, a: Record<string, unknown>, cwd: string, emit: Emit = noop): Promise<ToolResult> {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  if (name === 'android_adb') return androidAdb(str('args') || str('command'), emit)
  const lab = (str('lab') || 'linux').toLowerCase()
  if (!isLab(lab)) return { ok: false, output: `Labo inconnu : « ${lab} ». Labos : ${LAB_IDS.join(', ')}.` }
  if (lab === 'windows-vm') return vmTool(name, a, cwd, emit, resizePng)

  if (name === 'lab_screenshot' && lab === 'android') {
    await ensureEmulator(emit)
    const r = await exec((await adbBin())!, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { timeout: 30_000, maxText: 1000 })
    if (!isPng(r.stdout)) return { ok: false, output: `Capture impossible : ${r.out.slice(0, 300)}` }
    const png = await resizePng(r.stdout, 1200)
    return { ok: true, output: "Capture de l'écran du téléphone virtuel (1080 × 2400, réduite à 1200 px de haut).", image: `data:image/png;base64,${png.toString('base64')}` }
  }

  await ensureLab(lab, emit)
  const c = ctr(lab)
  switch (name) {
    case 'lab_run': {
      const command = str('command')
      if (!command.trim()) return { ok: false, output: 'Paramètre « command » manquant.' }
      const t = Math.min(1800, Math.max(5, Number(a.timeout) || (lab === 'android' ? 900 : 300)))
      const dir = labPath(lab, str('cwd'))
      const script = `cd ${shq(dir)} 2>/dev/null || { echo ${shq(`Dossier introuvable dans le labo : ${dir}`)}; exit 1; }\n${command}`
      const r = await docker(['exec', '-e', 'TERM=dumb', '-e', 'NO_COLOR=1', '-e', 'PAGER=cat', '-e', 'GIT_PAGER=cat', c, 'timeout', '-k', '5', String(t), 'bash', '-c', script], {
        timeout: (t + 30) * 1000,
      })
      const code = r.timedOut ? 124 : r.code
      const note = code === 124 || code === 137 ? `\n[arrêtée : plus de ${t} s. Les serveurs et programmes graphiques se lancent en arrière-plan : « nohup … > /tmp/app.log 2>&1 & »]` : ''
      return { ok: code === 0, output: `${clip(r.out.trim() || '(aucune sortie)')}${note}\n[labo ${LABEL[lab]} · code de sortie : ${code}]` }
    }
    case 'lab_write_file': {
      if (!str('path')) return { ok: false, output: 'Paramètre « path » manquant.' }
      const p = labPath(lab, str('path'))
      const content = typeof a.content === 'string' ? a.content : ''
      const r = await docker(['exec', '-i', c, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', p], { input: content, timeout: 60_000 })
      if (r.code !== 0) return { ok: false, output: r.out.trim() || 'Écriture impossible.' }
      const host = hostPath(lab, p)
      return { ok: true, output: `Écrit dans le labo ${LABEL[lab]} : ${p} (${Buffer.byteLength(content)} octets)${host ? `\nSur l'ordinateur : ${host}` : ''}` }
    }
    case 'lab_read_file': {
      const p = labPath(lab, str('path'))
      const r = await docker(
        ['exec', c, 'sh', '-c', 'if [ -d "$1" ]; then ls -la "$1"; exit 3; fi; [ -f "$1" ] || { echo "Fichier introuvable : $1" >&2; exit 2; }; head -c 200000 "$1"', 'sh', p],
        { timeout: 30_000, maxText: 400_000 },
      )
      if (r.code === 3) return { ok: true, output: `${p} est un dossier :\n${clip(r.out.trim())}` }
      if (r.code !== 0) return { ok: false, output: r.out.trim() || `Lecture impossible : ${p}` }
      if (r.stdout.includes(0)) return { ok: false, output: `${p} est un fichier binaire.` }
      return { ok: true, output: r.stdout.toString('utf8') + (r.stdout.length >= 200_000 ? '\n… (fichier tronqué)' : '') }
    }
    case 'lab_screenshot': {
      const r = await docker(['exec', c, 'sh', '-c', SCREEN_CMD], { timeout: 30_000, maxText: 1000 })
      if (!isPng(r.stdout)) return { ok: false, output: `Capture impossible : ${r.out.slice(0, 300)}` }
      return { ok: true, output: `Capture de l'écran virtuel du labo ${LABEL[lab]} (1280 × 800).`, image: `data:image/png;base64,${r.stdout.toString('base64')}` }
    }
    case 'lab_copy_in': {
      const raw = str('source').trim()
      if (!raw) return { ok: false, output: 'Paramètre « source » manquant.' }
      const src = path.resolve(cwd, raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw)
      if (!existsSync(src)) return { ok: false, output: `Introuvable sur l'ordinateur : ${src}` }
      const dest = labPath(lab, str('dest') || path.basename(src))
      await docker(['exec', c, 'mkdir', '-p', path.posix.dirname(dest)], { timeout: 20_000 })
      const r = await docker(['cp', src, `${c}:${dest}`], { timeout: 15 * 60_000 })
      if (r.code !== 0) return { ok: false, output: r.out.trim() || 'Copie impossible.' }
      return { ok: true, output: `Copié dans le labo ${LABEL[lab]} : ${src} → ${dest}` }
    }
    default:
      return { ok: false, output: `Outil inconnu : ${name}` }
  }
}

// ---------- État et actions (Réglages → Labos) ----------
export type LabState = {
  image: boolean
  container: 'none' | 'stopped' | 'running'
  outdated: boolean
  network: boolean
  ports: string | null
  workspace: string
  versions: string | null
  busy: string | null
}

export async function labStatus() {
  const d = await dockerInfo()
  const prefs = await readPrefs()
  const labs = {} as Record<DockerLab, LabState>
  const listed = d.running ? await docker(['images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=lumen-lab-*'], { timeout: 15_000 }) : null
  const images = new Set((listed?.stdout.toString() ?? '').split('\n').map((s) => s.trim()))
  for (const lab of DOCKER_LABS) {
    const tag = imageTag(lab)
    const c = d.running ? await inspect(lab) : null
    labs[lab] = {
      image: images.has(tag),
      container: c ? (c.running ? 'running' : 'stopped') : 'none',
      outdated: !!c && c.image !== tag,
      network: c ? c.network : prefs.network?.[lab] !== false,
      ports: c?.ports ? `127.0.0.1:${PORT_BASE[lab]}–${PORT_BASE[lab] + 4}` : null,
      workspace: path.join(WORK_ROOT, lab),
      versions: prefs.versions?.[tag] ?? null,
      busy: busy.get(lab) ?? null,
    }
  }
  const sdk = androidSdk()
  const img = sdk ? systemImage(sdk) : null
  const emulator = !!(sdk && sdkTool(sdk, 'emulator', 'emulator'))
  return {
    docker: d,
    root: WORK_ROOT,
    labs,
    android: {
      sdk,
      emulator,
      image: img?.label ?? null,
      device: emulator && img ? await deviceState() : ('off' as Device),
      starting: !!emuStarting,
      window: !!prefs.androidWindow,
      licenses: !!licensesDir(),
    },
    vm: await vmStatus(),
  }
}

export async function labAction(action: string, labArg: unknown, value: unknown, emit: Emit): Promise<void> {
  // Windows complet (machine virtuelle) : voir agent/winvm.ts
  if (labArg === 'windows-vm' || action === 'windows-license' || action.startsWith('vm-')) return vmAction(action, value, emit)
  const lab = isLab(labArg) && labArg !== 'windows-vm' ? labArg : null
  const need = () => {
    if (!lab) throw new Error('Labo inconnu')
    return lab
  }
  switch (action) {
    case 'prepare':
      return ensureLab(need(), emit)
    case 'update':
      return ensureLab(need(), emit, { rebuild: true })
    case 'stop':
      await docker(['stop', '-t', '2', ctr(need())], { timeout: 60_000 })
      return
    case 'reset':
      await docker(['rm', '-f', ctr(need())], { timeout: 60_000 }) // les fichiers de « Lumen Labo » sont conservés
      return
    case 'network': {
      const l = need()
      const on = !!value
      await writePrefs((p) => void (p.network = { ...p.network, [l]: on }))
      const c = await inspect(l)
      if (c && c.network !== on) {
        const r = await docker(['network', on ? 'connect' : 'disconnect', 'bridge', ctr(l)], { timeout: 30_000 })
        if (r.code !== 0) throw new Error(r.out.trim())
      }
      return
    }
    case 'reveal': {
      // « exe » : les programmes Windows fabriqués par l'outil build_exe
      const dir = lab ? path.join(WORK_ROOT, lab) : value === 'exe' ? path.join(WORK_ROOT, 'exe') : WORK_ROOT
      await fs.mkdir(dir, { recursive: true })
      if (isMac) await exec('open', [dir])
      else if (isWin) await exec('explorer.exe', [dir])
      else await exec('xdg-open', [dir])
      return
    }
    case 'docker':
      return ensureDocker(emit)
    case 'emulator-start':
      return ensureEmulator(emit)
    case 'emulator-stop':
      return stopEmulator()
    case 'emulator-window':
      await writePrefs((p) => void (p.androidWindow = !!value))
      return
    case 'android-license':
      return acceptAndroidLicense()
    default:
      throw new Error(`Action inconnue : ${action}`)
  }
}
