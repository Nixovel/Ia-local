// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Réglages → Labos : machines isolées (Linux, Windows, Android, Windows complet) où les modèles testent leurs programmes.
import { useCallback, useEffect, useState } from 'react'
import {
  AppWindow, Check, ExternalLink, FileSearch, FolderOpen, Globe, LoaderCircle, Monitor, Play, Power, RefreshCw, RotateCcw, Smartphone, Square, Terminal, Trash2,
  type LucideIcon,
} from 'lucide-react'
import { toast, useStore } from '../store'
import { LAB_IDS, LabError, labAction, labStatus, progressLabel, type DockerLabId, type LabActionName, type LabEvent, type LabId, type LabStatus, type VmStatus } from '../lib/lab'
import { useLabScreen } from '../lib/labScreen'
import { Button, IconButton, StatusDot } from './ui'

const META: Record<DockerLabId, { name: string; icon: LucideIcon; desc: string; size: string }> = {
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
      if ((action === 'prepare' || action === 'update') && lab) toast(`Labo ${lab === 'windows-vm' ? 'Windows complet' : META[lab].name} prêt`, 'success')
    } catch (e) {
      const needs = e instanceof LabError ? e.needs : undefined
      toast(
        needs === 'windows-license'
          ? 'Acceptez d’abord la licence de Windows 11 (ci-dessous).'
          : needs === 'windows-iso'
            ? 'Téléchargez d’abord l’ISO de Windows 11 ARM64 chez Microsoft, ou choisissez-la (ci-dessous).'
            : e instanceof LabError && e.needsLicense
              ? 'Acceptez d’abord la licence du SDK Android (ci-dessous).'
              : (e as Error).message.split('\n')[0],
        'danger',
      )
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
            <VmRow vm={st.vm} run={runs['windows-vm']} act={act} />
          </div>

          <VmSetup vm={st.vm} runs={runs} act={act} />

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
              Dossier partagé : {st.root}. Un serveur lancé dans un labo s'ouvre sur 127.0.0.1 (ports 18000+ Linux, 19000+ Windows, 20000+ Android, 21000+ Windows complet).
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

// ---------- Windows complet : vraie machine virtuelle Windows 11 ARM (Mac à processeur Apple) ----------
type Act = (key: string, action: LabActionName, lab?: LabId | null, value?: unknown) => Promise<void>
const gb = (n: number) => `${(n / 1e9).toFixed(1).replace('.', ',')} Go`
const LICENSE_URL = 'https://www.microsoft.com/fr-fr/useterms'

function vmPill(vm: VmStatus, running: boolean): { tone: string; text: string } {
  if (vm.phase === 'installing')
    return vm.state === 'off' && !running ? { tone: 'danger', text: 'Installation interrompue' } : { tone: 'accent', text: `Installation · ${vm.minutes} min` }
  if (running || vm.busy) return { tone: 'accent', text: 'En cours…' }
  if (vm.phase === 'none') return { tone: 'neutral', text: 'À installer' }
  if (vm.state === 'on') return { tone: 'success', text: 'En marche' }
  if (vm.state === 'booting') return { tone: 'accent', text: 'Démarrage…' }
  return { tone: 'neutral', text: 'Arrêtée' }
}

function VmRow({ vm, run, act }: { vm: VmStatus; run?: LabEvent; act: Act }) {
  const busy = !!run || !!vm.busy
  const pill = vmPill(vm, !!run)
  const progress = progressLabel(run) || vm.progress || ''
  const ready = vm.phase === 'ready'
  const showScreen = () => {
    useStore.getState().setSettingsOpen(false)
    useLabScreen.getState().show('windows-vm')
  }
  return (
    <div className="lab-row">
      <span className="lab-icon">
        <Monitor size={16} strokeWidth={1.6} />
      </span>
      <span className="toggle-text">
        <span className="label-sm lab-name">
          Windows complet
          <span className={`lab-pill tone-${pill.tone}`}>{pill.text}</span>
        </span>
        <span className="caption muted ellipsis" title={vm.versions ?? undefined}>
          {vm.disk > 0 ? `Disque ${gb(vm.disk)} · ` : '≈ 20 Go (+ ISO 8,5 Go) · '}
          {vm.versions ?? 'Vrai Windows 11 ARM (machine virtuelle) · PowerShell, .exe ARM64 et x64, .NET'}
        </span>
        {progress ? (
          <span className="caption accent ellipsis">{progress}</span>
        ) : vm.error ? (
          <span className="caption danger ellipsis" title={vm.error}>
            {vm.error}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className={`toggle-chip lab-net${vm.network ? ' is-on' : ' is-off'}`}
        title={vm.network ? 'Internet autorisé dans la machine Windows (winget, téléchargements). Cliquer pour le couper (redémarre la machine).' : 'Machine Windows coupée d’Internet. Cliquer pour le rétablir (redémarre la machine).'}
        aria-pressed={vm.network}
        disabled={busy || !vm.supported}
        onClick={() => void act('windows-vm:net', 'network', 'windows-vm', !vm.network)}
      >
        <Globe size={13} strokeWidth={1.6} />
      </button>
      {ready && vm.state !== 'off' ? (
        <Button small variant="ghost" icon={Square} disabled={busy} onClick={() => void act('windows-vm', 'stop', 'windows-vm')}>
          Arrêter
        </Button>
      ) : (
        <Button
          small
          variant={ready ? 'secondary' : 'primary'}
          icon={busy ? LoaderCircle : Play}
          disabled={busy || !vm.supported || !vm.qemu || (vm.phase === 'installing' && vm.state !== 'off')}
          onClick={() => void act('windows-vm', 'prepare', 'windows-vm')}
        >
          {ready ? 'Démarrer' : vm.phase === 'installing' ? 'Reprendre' : 'Préparer'}
        </Button>
      )}
      <IconButton icon={Monitor} label="Voir et piloter l’écran de Windows à côté du chat" disabled={vm.state === 'off'} onClick={showScreen} />
      <IconButton
        icon={RotateCcw}
        label="Réinitialiser : retour à Windows tout juste installé (quelques secondes ; vos fichiers de « Lumen Labo » sont gardés)"
        disabled={busy || !ready}
        onClick={() => void act('windows-vm', 'reset', 'windows-vm')}
      />
      <IconButton
        icon={Trash2}
        label={`Supprimer la machine Windows (libère ${vm.disk ? gb(vm.disk) : 'son disque'} ; réinstallation ≈ 15 min)`}
        disabled={busy || vm.phase === 'none'}
        onClick={() => {
          if (window.confirm(`Supprimer la machine Windows et son disque (${gb(vm.disk)}) ? Tout ce qui est installé dedans sera perdu. Les fichiers de « Lumen Labo » sont gardés.`))
            void act('windows-vm', 'vm-delete', 'windows-vm')
        }}
      />
      <IconButton icon={FolderOpen} label={`Ouvrir le dossier des fichiers écrits (${vm.workspace})`} onClick={() => void act('windows-vm:reveal', 'reveal', 'windows-vm')} />
    </div>
  )
}

/** Avant l'installation : Mac compatible, QEMU, ISO officielle de Microsoft, licence de Windows. */
function VmSetup({ vm, runs, act }: { vm: VmStatus; runs: Record<string, LabEvent>; act: Act }) {
  if (vm.phase === 'ready') {
    return (
      <div className="web-account">
        <Monitor size={15} className={vm.state === 'on' ? 'success' : 'muted'} />
        <span className="toggle-text">
          <span className="caption muted">
            Windows complet : PowerShell par SSH ({vm.ssh}), serveurs sur {vm.ports}. Démarre tout seul quand le modèle s’en sert.
          </span>
        </span>
        <button
          type="button"
          className={`toggle-chip${vm.window ? ' is-on' : ''}`}
          title="Ouvrir aussi la fenêtre de QEMU au prochain démarrage (l’écran est de toute façon visible dans Lumen)"
          aria-pressed={vm.window}
          onClick={() => void act('vm:window', 'vm-window', 'windows-vm', !vm.window)}
        >
          Fenêtre
        </button>
      </div>
    )
  }
  if (!vm.supported)
    return <p className="caption muted">Windows complet (vraie machine virtuelle Windows 11) : uniquement sur Mac à processeur Apple (M1 ou plus récent).</p>
  return (
    <>
      {!vm.qemu && (
        <div className="web-account">
          <Terminal size={15} className="muted" />
          <span className="toggle-text">
            <span className="label-sm">QEMU nécessaire</span>
            <span className="caption muted">Installez-le dans le Terminal : « brew install qemu » (Homebrew, gratuit), puis rouvrez ces réglages.</span>
          </span>
          <Button small variant="ghost" icon={ExternalLink} onClick={() => open('https://brew.sh')}>
            Homebrew
          </Button>
        </div>
      )}
      <div className="web-account">
        <FileSearch size={15} className={vm.iso ? 'success' : 'muted'} />
        <span className="toggle-text">
          <span className="label-sm">Windows 11 ARM64 (ISO officielle de Microsoft)</span>
          <span className="caption muted ellipsis" title={vm.iso?.path}>
            {vm.iso
              ? `Trouvée : ${vm.iso.path.split('/').pop()} (${gb(vm.iso.size)})`
              : 'À télécharger chez Microsoft (≈ 8,5 Go, « Windows 11 (ISO édition multiple pour Arm64) ») : Lumen la trouve dans Téléchargements.'}
          </span>
        </span>
        <Button small variant={vm.iso ? 'ghost' : 'primary'} icon={ExternalLink} onClick={() => open(vm.isoPage)}>
          Microsoft
        </Button>
        <Button small variant="ghost" icon={runs['vm:iso'] ? LoaderCircle : FileSearch} disabled={!!runs['vm:iso']} onClick={() => void act('vm:iso', 'vm-iso', 'windows-vm')}>
          {vm.iso ? 'Changer…' : 'Choisir…'}
        </Button>
      </div>
      {!vm.license && (
        <div className="web-account">
          <Check size={15} className="muted" />
          <span className="toggle-text">
            <span className="label-sm">Licence de Windows 11</span>
            <span className="caption muted">
              Lumen installe Windows tout seul : vous acceptez ses termes de licence. Windows 11 Pro non activé (clé générique d’installation de Microsoft).
            </span>
          </span>
          <Button small variant="ghost" icon={ExternalLink} onClick={() => open(LICENSE_URL)}>
            Lire
          </Button>
          <Button small variant="primary" onClick={() => void act('vm:license', 'windows-license', 'windows-vm')}>
            J'accepte
          </Button>
        </div>
      )}
    </>
  )
}
