// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Panneau « Écran du labo », à côté du chat : l'écran d'un labo en direct (ce que le modèle voit et fait), que
// l'utilisateur peut aussi piloter (clic, clic droit, molette, clavier). Windows (VM), Linux, Android.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import { Keyboard, LoaderCircle, Monitor, MousePointerClick, Play, X } from 'lucide-react'
import { toast } from '../store'
import { useLabScreen } from '../lib/labScreen'
import { LAB_LABELS, labAction, labInput, labScreen, labStatus, progressLabel, type LabEvent, type LabId, type LabStatus, type ScreenInput } from '../lib/lab'
import { Button, IconButton } from './ui'

const ORDER: LabId[] = ['windows-vm', 'linux', 'android']
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn'])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Frame = { url: string; w: number; h: number; at: number }

/** Taille d'une image PNG (en-tête IHDR) sans la décoder. */
async function pngSize(blob: Blob): Promise<{ w: number; h: number }> {
  const v = new DataView(await blob.slice(16, 24).arrayBuffer())
  return { w: v.getUint32(0), h: v.getUint32(4) }
}

export function LabScreen() {
  const lab = useLabScreen((s) => s.lab)
  const { setLab, close } = useLabScreen.getState()
  const [frame, setFrame] = useState<Frame | null>(null)
  const [live, setLive] = useState<'loading' | 'live' | 'off' | 'error'>('loading')
  const [control, setControl] = useState(true)
  const [focused, setFocused] = useState(false)
  const [status, setStatus] = useState<LabStatus | null>(null)
  const [run, setRun] = useState<LabEvent | null>(null)
  const lastInput = useRef(0)
  const lastWheel = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const lastError = useRef({ text: '', at: 0 })

  // Images en boucle : ≈ 3 par seconde pour la machine Windows, plus vite juste après un clic ou une touche
  useEffect(() => {
    let stop = false
    const ctrl = new AbortController()
    const urls: string[] = []
    setFrame(null)
    setLive('loading')
    void (async () => {
      while (!stop) {
        if (document.hidden) {
          await sleep(1000)
          continue
        }
        const t0 = performance.now()
        let off = false
        try {
          const blob = await labScreen(lab, ctrl.signal)
          if (stop) break
          if (blob) {
            const { w, h } = await pngSize(blob)
            if (stop) break // on a changé de labo pendant la lecture : image périmée
            const url = URL.createObjectURL(blob)
            urls.push(url)
            setFrame({ url, w, h, at: Date.now() })
            setLive('live')
            while (urls.length > 3) URL.revokeObjectURL(urls.shift()!) // l'image affichée reste valide
          } else {
            off = true
            setLive('off')
          }
        } catch {
          if (stop) break
          off = true
          setLive('error')
        }
        const fast = Date.now() - lastInput.current < 2500
        const period = off ? 3000 : fast ? 120 : lab === 'windows-vm' ? 300 : 800
        await sleep(Math.max(60, period - (performance.now() - t0)))
      }
    })()
    return () => {
      stop = true
      ctrl.abort()
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [lab])

  // Labo éteint : on lit son état (installation, démarrage…) pour l'expliquer
  useEffect(() => {
    if (live === 'live') return
    let stop = false
    const tick = () => labStatus().then((s) => !stop && setStatus(s)).catch(() => {})
    tick()
    const t = setInterval(tick, 4000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [live, lab])

  // Une commande à la fois, dans l'ordre (les touches tapées vite ne se doublent pas) ; une même erreur n'est affichée qu'une fois
  const send = (ev: ScreenInput) => {
    if (!control || live !== 'live') return
    lastInput.current = Date.now()
    queue.current = queue.current.then(() =>
      labInput(lab, ev).catch((e: Error) => {
        if (e.message === lastError.current.text && Date.now() - lastError.current.at < 5000) return
        lastError.current = { text: e.message, at: Date.now() }
        toast(e.message, 'danger')
      }),
    )
  }
  const where = (e: MouseEvent | WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    return { x, y, px: x * (frame?.w ?? 0), py: y * (frame?.h ?? 0) }
  }
  const onKey = (e: KeyboardEvent) => {
    if (!control || live !== 'live' || MODIFIERS.has(e.key)) return
    e.preventDefault()
    send({ type: 'key', code: e.code, key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
  }

  const start = async () => {
    setRun({})
    try {
      await labAction(lab === 'android' ? 'emulator-start' : 'prepare', lab === 'android' ? null : lab, undefined, setRun)
    } catch (e) {
      toast((e as Error).message.split('\n')[0], 'danger')
    } finally {
      setRun(null)
    }
  }

  const vm = status?.vm
  const offText = (() => {
    if (lab === 'windows-vm') {
      if (!vm) return 'Machine Windows éteinte.'
      if (!vm.supported) return 'La machine Windows complète fonctionne sur Mac à processeur Apple.'
      if (vm.busy || vm.progress) return vm.progress ?? 'Machine Windows : opération en cours…'
      if (vm.phase === 'none') return 'Machine Windows pas encore installée : Réglages → Labos → « Windows complet » → Préparer.'
      if (vm.phase === 'installing') return vm.error ?? `Installation de Windows · ${vm.minutes} min`
      return 'Machine Windows éteinte : elle démarre toute seule quand le modèle s’en sert.'
    }
    if (lab === 'android') return status && !status.android.emulator ? 'Pas de téléphone virtuel : installez Android Studio.' : 'Téléphone virtuel éteint.'
    return `Labo ${LAB_LABELS[lab]} arrêté : il démarre tout seul quand le modèle s’en sert.`
  })()
  const canStart =
    lab === 'windows-vm' ? !!vm && vm.phase === 'ready' && !vm.busy : lab === 'android' ? !!status?.android.emulator : !!status?.docker.installed
  const age = frame ? Math.round((Date.now() - frame.at) / 1000) : 0

  return (
    <aside className="panel lab-screen" aria-label="Écran du labo">
      <div className="panel-head">
        <Monitor size={16} strokeWidth={1.6} className={live === 'live' ? 'success' : 'muted'} />
        <div className="panel-title">
          <span className="label-sm">Écran du labo</span>
          <span className="caption muted ellipsis">
            {live === 'live' && frame ? `${LAB_LABELS[lab]} · ${frame.w} × ${frame.h} · en direct` : LAB_LABELS[lab]}
          </span>
        </div>
        <span className="spacer" />
        <IconButton
          icon={MousePointerClick}
          label={control ? 'Pilotage activé : vos clics et touches vont au labo (cliquer pour seulement regarder)' : 'Regarder seulement (cliquer pour piloter)'}
          active={control}
          onClick={() => setControl((v) => !v)}
        />
        <IconButton icon={X} label="Fermer l’écran du labo" onClick={close} />
      </div>
      <div className="panel-bar">
        <div className="segmented">
          {ORDER.map((id) => (
            <button type="button" key={id} className={id === lab ? 'is-on' : ''} onClick={() => setLab(id)}>
              {LAB_LABELS[id]}
            </button>
          ))}
        </div>
      </div>
      <div
        className={`lab-screen-canvas${control && live === 'live' ? ' is-control' : ''}`}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        {live === 'live' && frame ? (
          <img
            src={frame.url}
            alt={`Écran du labo ${LAB_LABELS[lab]}`}
            draggable={false}
            onClick={(e) => send({ type: 'click', ...where(e), button: 'left' })}
            onAuxClick={(e) => e.button === 1 && send({ type: 'click', ...where(e), button: 'middle' })}
            onContextMenu={(e) => {
              e.preventDefault()
              send({ type: 'click', ...where(e), button: 'right' })
            }}
            onWheel={(e) => {
              if (Date.now() - lastWheel.current < 120) return
              lastWheel.current = Date.now()
              send({ type: 'scroll', ...where(e), dy: Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 100)) })
            }}
          />
        ) : (
          <div className="lab-screen-empty">
            {live === 'loading' ? <LoaderCircle size={20} className="muted" /> : <Monitor size={22} strokeWidth={1.4} className="muted" />}
            <span className="caption muted">{live === 'loading' ? 'Connexion à l’écran…' : run ? progressLabel(run) || 'Démarrage…' : offText}</span>
            {live !== 'loading' && canStart && (
              <Button small variant="secondary" icon={run ? LoaderCircle : Play} disabled={!!run} onClick={() => void start()}>
                Démarrer
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="panel-foot">
        {control && live === 'live' && focused ? <Keyboard size={13} className="accent" /> : null}
        <span className="caption muted ellipsis">
          {live !== 'live'
            ? 'Le modèle voit cet écran avec lab_screenshot.'
            : !control
              ? 'Lecture seule : activez le pilotage pour cliquer et taper.'
              : focused
                ? `Clavier transmis au labo (⌘ = Ctrl).${age > 3 ? ` Image d’il y a ${age} s.` : ''}`
                : 'Cliquez dans l’écran pour piloter : clic droit, molette et clavier sont transmis.'}
        </span>
      </div>
    </aside>
  )
}
