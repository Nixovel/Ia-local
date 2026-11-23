// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Assistant d'installation : Ollama (détecter, installer, démarrer) et diagnostic complet, via le pont local.
import { agentInfo } from './agent'

export type OllamaStatus = { platform: string; installed: boolean; running: boolean; canInstall: boolean; command: string }
export type InstallEvent = { status?: 'download' | 'install' | 'start'; loaded?: number; total?: number; done?: boolean; error?: string; command?: string }

async function bridge(path: string, init: RequestInit = {}) {
  const { token } = await agentInfo()
  return fetch(path, { ...init, headers: { 'Content-Type': 'application/json', 'x-lumen-token': token, ...(init.headers ?? {}) }, cache: 'no-store' })
}

export async function ollamaStatus(): Promise<OllamaStatus> {
  const r = await bridge('/agent/ollama')
  if (!r.ok) throw new Error(`Pont local indisponible (${r.status})`)
  return (await r.json()) as OllamaStatus
}

export async function startOllama(): Promise<boolean> {
  const r = await bridge('/agent/ollama', { method: 'POST', body: JSON.stringify({ action: 'start' }) })
  return !!((await r.json()) as { ok?: boolean }).ok
}

/** Installe Ollama (téléchargement officiel) ; `onEvent` reçoit la progression. Résout sur le dernier événement. */
export async function installOllama(onEvent: (e: InstallEvent) => void): Promise<InstallEvent> {
  const r = await bridge('/agent/ollama', { method: 'POST', body: JSON.stringify({ action: 'install' }) })
  if (!r.ok || !r.body) throw new Error(`Pont local indisponible (${r.status})`)
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  let last: InstallEvent = {}
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      last = JSON.parse(line) as InstallEvent
      onEvent(last)
    }
  }
  return last
}

/** Le même diagnostic que « lumen doctor » : Node, dépendances, build, voix, Ollama, test de l'IA. */
export async function runDoctor(): Promise<{ ok: boolean; output: string }> {
  const r = await bridge('/agent/doctor')
  if (!r.ok) throw new Error(`Pont local indisponible (${r.status})`)
  return (await r.json()) as { ok: boolean; output: string }
}
