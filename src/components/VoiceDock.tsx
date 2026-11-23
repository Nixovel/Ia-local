// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect, useRef } from 'react'
import { Hand, Mic, MicOff, X } from 'lucide-react'
import { meter, useVoice } from '../voice/state'
import { interrupt, stopConversation, toggleMic } from '../voice/conversation'
import { Button, IconButton } from './ui'

const STATUS = {
  off: '',
  loading: 'Préparation de la voix…',
  listening: 'Je vous écoute…',
  hearing: 'Je vous entends…',
  transcribing: 'Je transcris…',
  thinking: 'Je réfléchis…',
  speaking: 'Je vous réponds…',
} as const

/** Conversation vocale (à la place de la zone de saisie) : orbe qui vit avec la voix, ce qui a été compris, ce qui est dit. */
export function VoiceDock() {
  const phase = useVoice((s) => s.phase)
  const heard = useVoice((s) => s.heard)
  const saying = useVoice((s) => s.saying)
  const muted = useVoice((s) => s.micMuted)
  const progress = useVoice((s) => s.progress)
  const upgrade = useVoice((s) => s.upgrade)
  const orb = useRef<HTMLButtonElement>(null)

  // L'orbe suit le niveau sonore (micro ou voix de Lumen) sans passer par React : 60 images/s, aucun re-rendu.
  useEffect(() => {
    let raf = 0
    let smooth = 0
    const tick = () => {
      smooth += (meter.level - smooth) * (meter.level > smooth ? 0.35 : 0.08)
      orb.current?.style.setProperty('--lvl', smooth.toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Échap : terminer ; Espace (hors champ de saisie) : couper la parole
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return
      if (e.key === 'Escape') void stopConversation()
      else if (e.key === ' ') {
        e.preventDefault()
        interrupt()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const busy = phase === 'thinking' || phase === 'speaking'
  const pct = progress?.total ? Math.floor((progress.loaded / progress.total) * 100) : null
  const status =
    phase === 'loading' && progress
      ? `${progress.what === 'stt' ? 'Téléchargement de la reconnaissance vocale' : 'Téléchargement de la voix'}${pct != null ? ` · ${pct} %` : '…'}`
      : phase === 'listening' && muted
        ? 'Micro coupé'
        : STATUS[phase]

  return (
    <div className={`voice-dock is-${phase}${muted ? ' is-muted' : ''}`} role="region" aria-label="Conversation vocale">
      <button
        type="button"
        ref={orb}
        className="voice-orb"
        onClick={busy ? interrupt : undefined}
        title={busy ? 'Couper la parole (Espace)' : status}
        aria-label={status}
      >
        <i className="voice-ring r1" />
        <i className="voice-ring r2" />
        <i className="voice-ring r3" />
        <span className="voice-core" />
      </button>
      <div className="voice-text" aria-live="polite">
        <span className="label voice-status">{status}</span>
        {saying ? (
          <span className="voice-saying">{saying}</span>
        ) : heard ? (
          <span className="voice-heard">« {heard} »</span>
        ) : (
          <span className="caption muted">
            {phase === 'loading'
              ? 'La première fois, la voix et la reconnaissance se téléchargent (une seule fois), puis tout reste sur votre machine.'
              : 'Parlez naturellement, Lumen répond à voix haute. Dites « stop » ou appuyez sur Échap pour terminer.'}
          </span>
        )}
        {saying && heard && <span className="caption muted ellipsis">Vous : « {heard} »</span>}
        {upgrade && phase !== 'loading' && (
          <span className="caption muted">
            Compréhension la plus précise en préparation
            {upgrade.total ? ` · ${Math.floor((upgrade.loaded / upgrade.total) * 100)} %` : '…'} (elle prendra le relais toute seule)
          </span>
        )}
      </div>
      <div className="voice-actions">
        {busy && (
          <Button small icon={Hand} onClick={interrupt} title="Couper la parole (Espace)">
            Interrompre
          </Button>
        )}
        <IconButton icon={muted ? MicOff : Mic} label={muted ? 'Réactiver le micro' : 'Couper le micro'} active={muted} onClick={() => void toggleMic()} />
        <IconButton icon={X} label="Terminer la conversation vocale (Échap)" onClick={() => void stopConversation()} />
      </div>
    </div>
  )
}
