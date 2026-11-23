// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// État de la voix pour l'interface (non sauvegardé). Le niveau sonore change 60 fois par seconde :
// il vit dans `meter`, lu directement par l'animation, pour ne pas faire re-rendre React.
import { create } from 'zustand'
import type { SttModel } from './catalog'

export type VoicePhase =
  | 'off'
  | 'loading' // téléchargement / préparation des modèles vocaux
  | 'listening' // attend que l'utilisateur parle
  | 'hearing' // l'utilisateur parle
  | 'transcribing' // Whisper transcrit
  | 'thinking' // le modèle prépare sa réponse
  | 'speaking' // Lumen parle

export type VoiceState = {
  phase: VoicePhase
  heard: string // dernière phrase comprise
  saying: string // phrase en cours de lecture
  progress: { what: 'stt' | 'tts'; loaded: number; total: number } | null
  error: string | null
  micMuted: boolean
  readingId: string | null // message lu à voix haute (bouton « Écouter »)
  readingLoading: boolean
  /**
   * Conversation vocale : le texte de la réponse s'affiche au rythme de la voix (comme des sous-titres).
   * Par message : le passage [from, to] est en cours de lecture depuis `at` (ms) pendant `dur` (s).
   */
  reveal: Record<string, { from: number; to: number; at: number; dur: number }>
  /** Modèle de reconnaissance qui transcrit maintenant, et préparation du plus précis en arrière-plan */
  sttModel: SttModel | null
  upgrade: { loaded: number; total: number } | null
}

export const useVoice = create<VoiceState>(() => ({
  phase: 'off',
  heard: '',
  saying: '',
  progress: null,
  error: null,
  micMuted: false,
  readingId: null,
  readingLoading: false,
  reveal: {},
  sttModel: null,
  upgrade: null,
}))

/** Niveau sonore (0 → 1) du micro ou de la voix de Lumen, pour l'animation. */
export const meter = { level: 0 }

/** Conversation vocale en cours : les réponses sont adaptées à l'oral. */
export const voiceActive = () => useVoice.getState().phase !== 'off'
