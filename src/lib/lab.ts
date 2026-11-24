// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Labos isolés (Linux, Android, Windows complet) côté interface : état, actions, écran en direct,
// via le pont local (agent/lab.ts, agent/winvm.ts).
import { agentInfo, resetAgentInfo } from './agent'

export type DockerLabId = 'linux' | 'android'
export type LabId = DockerLabId | 'windows-vm'
/** Labos en conteneur Docker (la machine virtuelle Windows a sa propre ligne dans les réglages). */
export const LAB_IDS: DockerLabId[] = ['linux', 'android']
export const LAB_LABELS: Record<LabId, string> = { 'windows-vm': 'Windows (VM)', linux: 'Linux', android: 'Android' }

/** Machine virtuelle Windows 11 ARM (labo « windows-vm »). */
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

export type LabStatus = {
  docker: { installed: boolean; running: boolean; provider?: string; version?: string; canStart: boolean }
  root: string
  labs: Record<DockerLabId, LabState>
  android: { sdk: string | null; emulator: boolean; image: string | null; device: 'off' | 'booting' | 'on'; starting: boolean; window: boolean; licenses: boolean }
  vm: VmStatus
}

export type LabEvent = {
  status?: 'docker' | 'build' | 'create' | 'start' | 'emulator' | 'vm-download' | 'vm-iso' | 'vm-install' | 'vm-finalize' | 'vm-boot'
  step?: number
  total?: number
  text?: string
  done?: boolean
  error?: string
  needsLicense?: boolean
  needs?: 'android-license' | 'windows-license' | 'windows-iso'
}

export type LabActionName =
  | 'prepare' | 'update' | 'stop' | 'reset' | 'network' | 'reveal' | 'docker'
  | 'emulator-start' | 'emulator-stop' | 'emulator-window' | 'android-license'
  | 'windows-license' | 'vm-iso' | 'vm-window' | 'vm-delete'

async function call(init: RequestInit = {}, retry = true): Promise<Response> {
  const { token } = await agentInfo()
  const r = await fetch('/agent/lab', { ...init, headers: { 'Content-Type': 'application/json', 'x-lumen-token': token }, cache: 'no-store' })
  if (r.status === 401 && retry) {
    resetAgentInfo() // le serveur a redémarré : nouveau jeton
    return call(init, false)
  }
  return r
}

export async function labStatus(): Promise<LabStatus> {
  const r = await call()
  if (!r.ok) throw new Error(`Pont local indisponible (${r.status})`)
  return (await r.json()) as LabStatus
}

export class LabError extends Error {
  needsLicense: boolean
  needs?: LabEvent['needs']
  constructor(message: string, needsLicense = false, needs?: LabEvent['needs']) {
    super(message)
    this.needsLicense = needsLicense
    this.needs = needs
  }
}

/** Image de l'écran d'un labo allumé (null s'il est éteint). */
export async function labScreen(lab: LabId, signal?: AbortSignal): Promise<Blob | null> {
  const { token } = await agentInfo()
  const r = await fetch(`/agent/lab/screen?lab=${encodeURIComponent(lab)}`, { headers: { 'x-lumen-token': token }, cache: 'no-store', signal })
  if (r.status === 401) {
    resetAgentInfo()
    throw new LabError('Jeton expiré')
  }
  if (r.status === 204) return null
  if (!r.ok) throw new LabError(`Écran indisponible (${r.status})`)
  return r.blob()
}

export type ScreenInput = {
  type: 'click' | 'scroll' | 'key'
  /** Position relative (0 à 1) et en pixels de la capture */
  x?: number
  y?: number
  px?: number
  py?: number
  button?: 'left' | 'right' | 'middle'
  double?: boolean
  dy?: number
  /** KeyboardEvent.code (touche physique) et KeyboardEvent.key */
  code?: string
  key?: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

/** Clic, molette ou touche envoyés à l'écran d'un labo. */
export async function labInput(lab: LabId, ev: ScreenInput): Promise<void> {
  const { token } = await agentInfo()
  const r = await fetch('/agent/lab/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lumen-token': token },
    body: JSON.stringify({ lab, ...ev }),
  })
  if (!r.ok) throw new LabError(((await r.json().catch(() => ({}))) as { output?: string }).output ?? `Commande refusée (${r.status})`)
}

/** Lance une action (préparer, démarrer le téléphone…) ; `onEvent` reçoit la progression. */
export async function labAction(action: LabActionName, lab?: LabId | null, value?: unknown, onEvent?: (e: LabEvent) => void): Promise<void> {
  const r = await call({ method: 'POST', body: JSON.stringify({ action, lab, value }) })
  if (!r.ok || !r.body) throw new LabError(`Pont local indisponible (${r.status})`)
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  let last: LabEvent = {}
  for (;;) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      last = JSON.parse(line) as LabEvent
      onEvent?.(last)
    }
  }
  if (last.error) throw new LabError(last.error, !!last.needsLicense, last.needs)
}

export function progressLabel(e: LabEvent | null | undefined): string {
  switch (e?.status) {
    case 'docker':
      return 'Démarrage de Docker…'
    case 'build':
      return e.total ? `Construction ${e.step}/${e.total}${e.text ? ` · ${e.text}` : ''}` : 'Construction…'
    case 'create':
      return 'Création de la machine…'
    case 'start':
      return 'Démarrage…'
    case 'emulator':
      return 'Démarrage du téléphone virtuel…'
    case 'vm-download':
    case 'vm-iso':
    case 'vm-install':
    case 'vm-finalize':
    case 'vm-boot':
      return e.text ?? 'Machine Windows…'
    default:
      return ''
  }
}
