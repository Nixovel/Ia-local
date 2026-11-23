// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Téléchargement de modèles Ollama, partagé par la page Modèles, l'accueil et l'agent.
// Les téléchargements continuent même si l'on change de vue (état dans le store).
import { toast, useStore } from '../store'
import { ollama } from './ollama'
import { prettyName } from './models'

const controllers = new Map<string, AbortController>()
const running = new Map<string, Promise<PullResult>>()

export type PullResult = { ok: boolean; error?: string }

const STATUS_FR = (s: string) =>
  s === 'pulling manifest' ? 'Récupération du manifeste'
  : s.startsWith('pulling') ? 'Téléchargement'
  : s.startsWith('verifying') ? 'Vérification'
  : s.startsWith('writing') ? 'Finalisation'
  : s === 'success' ? 'Terminé' : s

/** Lance (ou rejoint) le téléchargement d'un modèle et attend sa fin. */
export function startPull(raw: string): Promise<PullResult> {
  const name = raw.trim()
  if (!name) return Promise.resolve({ ok: false, error: 'Nom de modèle vide' })
  const existing = running.get(name)
  if (existing) return existing
  const p = doPull(name).finally(() => running.delete(name))
  running.set(name, p)
  return p
}

export const cancelPull = (name: string) => controllers.get(name)?.abort()

async function doPull(name: string): Promise<PullResult> {
  const { setPull, refreshRuntime } = useStore.getState()
  const ctrl = new AbortController()
  controllers.set(name, ctrl)
  setPull(name, { status: 'Préparation…' })
  let lastPct = -1
  let lastStatus = ''
  try {
    await ollama.pull(
      name,
      (p) => {
        const status = STATUS_FR(p.status)
        const pct = p.total ? Math.floor(((p.completed ?? 0) / p.total) * 200) : -1
        if (pct === lastPct && status === lastStatus) return
        lastPct = pct
        lastStatus = status
        setPull(name, { status, completed: p.completed, total: p.total })
      },
      ctrl.signal,
    )
    setPull(name, null)
    toast(`${prettyName(name)} est installé`, 'success')
    await refreshRuntime(true)
    return { ok: true }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      setPull(name, null)
      toast('Téléchargement annulé')
      return { ok: false, error: 'Téléchargement annulé' }
    }
    setPull(name, { status: 'Erreur', error: (e as Error).message })
    return { ok: false, error: (e as Error).message }
  } finally {
    controllers.delete(name)
  }
}
