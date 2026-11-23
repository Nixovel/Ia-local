// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Labos isolés (Linux, Windows, Android) côté interface : état et actions, via le pont local (agent/lab.ts).
import { agentInfo, resetAgentInfo } from './agent'

export type LabId = 'linux' | 'windows' | 'android'
export const LAB_IDS: LabId[] = ['linux', 'windows', 'android']

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
  labs: Record<LabId, LabState>
  android: { sdk: string | null; emulator: boolean; image: string | null; device: 'off' | 'booting' | 'on'; starting: boolean; window: boolean; licenses: boolean }
}

export type LabEvent = {
  status?: 'docker' | 'build' | 'create' | 'start' | 'emulator'
  step?: number
  total?: number
  text?: string
  done?: boolean
  error?: string
  needsLicense?: boolean
}

export type LabActionName =
  | 'prepare' | 'update' | 'stop' | 'reset' | 'network' | 'reveal' | 'docker'
  | 'emulator-start' | 'emulator-stop' | 'emulator-window' | 'android-license'

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
  constructor(message: string, needsLicense = false) {
    super(message)
    this.needsLicense = needsLicense
  }
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
  if (last.error) throw new LabError(last.error, !!last.needsLicense)
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
    default:
      return ''
  }
}
