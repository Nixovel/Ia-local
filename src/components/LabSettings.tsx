// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Réglages → Labos : machines isolées (Linux, Windows, Android) où les modèles testent leurs programmes.
import { useCallback, useEffect, useState } from 'react'
import { AppWindow, Check, ExternalLink, FolderOpen, Globe, LoaderCircle, Play, Power, RefreshCw, RotateCcw, Smartphone, Square, Terminal, type LucideIcon } from 'lucide-react'
import { toast, useStore } from '../store'
import { LAB_IDS, LabError, labAction, labStatus, progressLabel, type LabActionName, type LabEvent, type LabId, type LabStatus } from '../lib/lab'
import { Button, IconButton, StatusDot } from './ui'

const META: Record<LabId, { name: string; icon: LucideIcon; desc: string; size: string }> = {
  linux: { name: 'Linux', icon: Terminal, desc: 'Ubuntu LTS · Python, Node.js, GCC, Git…', size: '≈ 1,7 Go' },
  windows: { name: 'Windows', icon: AppWindow, desc: 'Wine · .exe, compilation MinGW, C#, PowerShell', size: '≈ 8 Go' },
  android: { name: 'Android', icon: Smartphone, desc: 'JDK, Gradle, SDK Android + téléphone virtuel', size: '≈ 6 Go' },
}

const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

export function LabSettings() {
  const labOn = useStore((s) => s.labMode)
  const [st, setSt] = useState<LabStatus | null | undefined>(undefined)
  const [err, setErr] = useState('')
  const [runs, setRuns] = useState<Record<string, LabEvent>>({})

  const refresh = useCallback(async () => {
    try {
      setSt(await labStatus())
      setErr('')
    } catch (e) {
      setSt(null)
      setErr((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 4000)
    return () => clearInterval(t)
  }, [refresh])

  const act = async (key: string, action: LabActionName, lab?: LabId | null, value?: unknown) => {
    setRuns((r) => ({ ...r, [key]: {} }))
    try {
      await labAction(action, lab, value, (e) => setRuns((r) => ({ ...r, [key]: e })))
      if ((action === 'prepare' || action === 'update') && lab) toast(`Labo ${META[lab].name} prêt`, 'success')
    } catch (e) {
      toast(e instanceof LabError && e.needsLicense ? 'Acceptez d’abord la licence du SDK Android (ci-dessous).' : (e as Error).message.split('\n')[0], 'danger')
    } finally {
      setRuns((r) => {
        const n = { ...r }
        delete n[key]
        return n
      })
      void refresh()
    }
  }

  const docker = st?.docker
  const android = st?.android

  return (
    <section className="dialog-section">
      <span className="label">Labos (tests isolés)</span>
      <button type="button" className="toggle-row" onClick={() => useStore.getState().setLabMode(!labOn)} aria-pressed={labOn}>
        <span className="toggle-text">
          <span className="label-sm">Laisser les modèles tester leurs programmes dans les labos</span>
          <span className="caption muted">
            Machines Linux, Windows et Android isolées : le modèle y installe, compile, lance et teste ce qu'il écrit, sans toucher à
            votre ordinateur. Seul le dossier « Lumen Labo » est partagé. Aussi activable avec le bouton « Labo ».
          </span>
        </span>
        <span className={`switch${labOn ? ' is-on' : ''}`}>
          <i />
        </span>
      </button>

      {st === undefined ? (
        <p className="caption muted">Vérification des labos…</p>
      ) : st === null ? (
        <p className="caption danger">Labos indisponibles : {err}</p>
      ) : (
        <>
          <div className="web-account">
            <StatusDot tone={docker?.running ? 'success' : docker?.installed ? 'accent' : 'danger'} />
            <span className="toggle-text">
              {docker?.running ? (
                <span className="caption muted">
                  Docker {docker.version} · {docker.provider} — moteur des labos prêt.
                </span>
              ) : docker?.installed ? (
                <span className="caption muted">Docker est installé mais arrêté.</span>
              ) : (
                <span className="caption muted">
                  Les labos ont besoin de Docker (gratuit) : OrbStack ou Docker Desktop sur Mac, Docker Desktop sur Windows, Docker Engine sur Linux.
                </span>
              )}
            </span>
            {docker && !docker.running && docker.canStart && (
              <Button small variant="primary" icon={runs.docker ? LoaderCircle : Play} disabled={!!runs.docker} onClick={() => void act('docker', 'docker')}>
                Démarrer
              </Button>
            )}
            {docker && !docker.installed && (
              <Button small variant="primary" icon={ExternalLink} onClick={() => open('https://docs.docker.com/get-started/get-docker/')}>
                Installer Docker
              </Button>
            )}
          </div>

          <div className="lab-list">
            {LAB_IDS.map((id) => {
              const lab = st.labs[id]
              const m = META[id]
              const run = runs[id]
              const busy = !!run || !!lab.busy
              const state = busy
                ? { tone: 'accent', text: 'Préparation…' }
                : lab.container === 'running'
                  ? { tone: 'success', text: 'En marche' }
                  : lab.container === 'stopped'
                    ? { tone: 'neutral', text: 'Arrêté' }
                    : lab.image
                      ? { tone: 'neutral', text: 'Prêt' }
                      : { tone: 'neutral', text: 'À préparer' }
              const progress = progressLabel(run) || (lab.busy === 'build' ? 'Construction en cours…' : '')
              return (
                <div className="lab-row" key={id}>
                  <span className="lab-icon">
                    <m.icon size={16} strokeWidth={1.6} />
                  </span>
                  <span className="toggle-text">
                    <span className="label-sm lab-name">
                      {m.name}
                      <span className={`lab-pill tone-${state.tone}`}>{state.text}</span>
                    </span>
                    <span className="caption muted ellipsis" title={lab.versions ?? m.desc}>
                      {lab.versions ?? `${m.desc} · ${m.size}`}
                    </span>
                    {progress && <span className="caption accent ellipsis">{progress}</span>}
                  </span>
                  <button
                    type="button"
                    className={`toggle-chip lab-net${lab.network ? ' is-on' : ' is-off'}`}
                    title={lab.network ? 'Internet autorisé dans ce labo (pip, npm, apt…). Cliquer pour le couper.' : 'Labo coupé d’Internet. Cliquer pour le rétablir.'}
                    aria-pressed={lab.network}
                    disabled={!docker?.running}
                    onClick={() => void act(`${id}:net`, 'network', id, !lab.network)}
                  >
                    <Globe size={13} strokeWidth={1.6} />
                  </button>
                  {lab.container === 'running' ? (
                    <Button small variant="ghost" icon={Square} disabled={busy} onClick={() => void act(id, 'stop', id)}>
                      Arrêter
                    </Button>
                  ) : (
                    <Button small variant={lab.image ? 'secondary' : 'primary'} icon={busy ? LoaderCircle : Play} disabled={busy || !docker?.installed} onClick={() => void act(id, 'prepare', id)}>
                      {lab.image ? 'Démarrer' : 'Préparer'}
                    </Button>
                  )}
                  <IconButton icon={RefreshCw} label="Mettre à jour : reconstruire avec les dernières versions (vos fichiers sont gardés)" disabled={busy || !docker?.running} onClick={() => void act(id, 'update', id)} />
                  <IconButton icon={RotateCcw} label="Réinitialiser : machine neuve au prochain usage (vos fichiers sont gardés)" disabled={busy || lab.container === 'none'} onClick={() => void act(id, 'reset', id)} />
                  <IconButton icon={FolderOpen} label={`Ouvrir le dossier partagé (${lab.workspace})`} onClick={() => void act(`${id}:reveal`, 'reveal', id)} />
                </div>
              )
            })}
          </div>

          {android && (
            <div className="web-account">
              <Smartphone size={15} className={android.device === 'on' ? 'success' : 'muted'} />
              <span className="toggle-text">
                {android.emulator && android.image ? (
                  <>
                    <span className="label-sm">
                      Téléphone virtuel ·{' '}
                      {android.device === 'on' ? 'allumé' : android.device === 'booting' || android.starting || runs.phone ? 'démarrage…' : 'éteint'}
                    </span>
                    <span className="caption muted">
                      {android.image} · appareil dédié « Lumen Labo », démarré tout seul quand le modèle teste une appli.
                    </span>
                  </>
                ) : (
                  <span className="caption muted">
                    Pour tester les applis sur un téléphone virtuel : installez Android Studio, puis un téléphone récent dans « Device Manager ».
                  </span>
                )}
              </span>
              {android.emulator && android.image ? (
                <>
                  <button
                    type="button"
                    className={`toggle-chip${android.window ? ' is-on' : ''}`}
                    title="Afficher la fenêtre du téléphone (au prochain démarrage), pour regarder le modèle tester"
                    aria-pressed={android.window}
                    onClick={() => void act('phone:window', 'emulator-window', null, !android.window)}
                  >
                    Fenêtre
                  </button>
                  {android.device === 'off' && !android.starting ? (
                    <Button small icon={runs.phone ? LoaderCircle : Power} disabled={!!runs.phone} onClick={() => void act('phone', 'emulator-start')}>
                      Allumer
                    </Button>
                  ) : (
                    <Button small variant="ghost" icon={Power} onClick={() => void act('phone:stop', 'emulator-stop')}>
                      Éteindre
                    </Button>
                  )}
                </>
              ) : (
                <Button small icon={ExternalLink} onClick={() => open('https://developer.android.com/studio')}>
                  Android Studio
                </Button>
              )}
            </div>
          )}

          {android && !android.licenses && (
            <div className="web-account">
              <Check size={15} className="muted" />
              <span className="toggle-text">
                <span className="label-sm">Licence du SDK Android</span>
                <span className="caption muted">Le labo Android utilise le SDK de Google : sa licence doit être acceptée une fois.</span>
              </span>
              <Button small variant="ghost" icon={ExternalLink} onClick={() => open('https://developer.android.com/studio/terms')}>
                Lire
              </Button>
              <Button small variant="primary" onClick={() => void act('license', 'android-license')}>
                J'accepte
              </Button>
            </div>
          )}

          <div className="field-row">
            <span className="caption muted">
              Dossier partagé : {st.root}. Un serveur lancé dans un labo s'ouvre sur 127.0.0.1 (ports 18000+ Linux, 19000+ Windows, 20000+ Android).
            </span>
            <span className="spacer" />
            <Button small variant="ghost" icon={FolderOpen} onClick={() => void act('root:reveal', 'reveal')}>
              Ouvrir
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
