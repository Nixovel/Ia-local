// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Voix et modèles de reconnaissance proposés : locaux, identiques sur tous les ordinateurs, choisis selon la machine.
import type { SystemInfo } from '../lib/hardware'

export type PiperVoice = 'fr_FR-tom-medium' | 'fr_FR-siwis-medium' | 'fr_FR-gilles-low' | 'fr_FR-siwis-low'
export type NaturalVoice = 'st-M1' | 'st-M2' | 'st-M3' | 'st-M4' | 'st-M5' | 'st-F1' | 'st-F2'
export type VoiceId = PiperVoice | NaturalVoice
export type SttModel = 'tiny' | 'base' | 'small' | 'turbo'

export type VoiceInfo = {
  id: VoiceId
  label: string
  desc: string
  sizeMB: number
  /** supertonic : voix naturelle (modèle commun ~400 Mo) ; piper : voix légère pour les petits PC */
  engine: 'supertonic' | 'piper'
  path?: string // Piper : dossier dans rhasspy/piper-voices
  style?: string // Supertonic : style de voix
}

export const VOICES: VoiceInfo[] = [
  // Hauteurs mesurées sur une même phrase : M2 ≈ 92 Hz, M5 ≈ 90 Hz, M3 ≈ 98 Hz, M4 ≈ 115 Hz, M1 ≈ 124 Hz
  { id: 'st-M2', label: 'Louis', desc: 'Homme, grave et posé (façon Jarvis)', sizeMB: 400, engine: 'supertonic', style: 'M2' },
  { id: 'st-M5', label: 'Victor', desc: 'Homme, très grave', sizeMB: 400, engine: 'supertonic', style: 'M5' },
  { id: 'st-M3', label: 'Marc', desc: 'Homme, grave et dynamique', sizeMB: 400, engine: 'supertonic', style: 'M3' },
  { id: 'st-M4', label: 'Paul', desc: 'Homme, voix douce', sizeMB: 400, engine: 'supertonic', style: 'M4' },
  { id: 'st-M1', label: 'Hugo', desc: 'Homme, voix claire', sizeMB: 400, engine: 'supertonic', style: 'M1' },
  { id: 'st-F1', label: 'Claire', desc: 'Femme, voix naturelle', sizeMB: 400, engine: 'supertonic', style: 'F1' },
  { id: 'st-F2', label: 'Léa', desc: 'Femme, voix naturelle', sizeMB: 400, engine: 'supertonic', style: 'F2' },
  { id: 'fr_FR-gilles-low', label: 'Gilles', desc: 'Homme, voix légère (petits PC)', sizeMB: 63, engine: 'piper', path: 'fr/fr_FR/gilles/low' },
  { id: 'fr_FR-tom-medium', label: 'Tom', desc: 'Homme, voix légère', sizeMB: 64, engine: 'piper', path: 'fr/fr_FR/tom/medium' },
  { id: 'fr_FR-siwis-low', label: 'Siwis', desc: 'Femme, voix la plus légère', sizeMB: 28, engine: 'piper', path: 'fr/fr_FR/siwis/low' },
]
export const voiceInfo = (id: VoiceId) => VOICES.find((v) => v.id === id) ?? VOICES[0]

/** Whisper : quantifié pour le processeur, ou large-v3-turbo sur la carte graphique (WebGPU) pour comprendre presque tout. */
export const STT: Record<SttModel, { repo: string; label: string; desc: string; sizeMB: number; gpu?: boolean }> = {
  tiny: { repo: 'onnx-community/whisper-tiny', label: 'Rapide', desc: 'Très petits PC : réagit vite, comprend moins bien', sizeMB: 41 },
  base: { repo: 'onnx-community/whisper-base', label: 'Légère', desc: 'Petits PC : correcte', sizeMB: 77 },
  small: { repo: 'onnx-community/whisper-small', label: 'Précise', desc: 'Bonne compréhension, sur le processeur', sizeMB: 249 },
  turbo: { repo: 'onnx-community/whisper-large-v3-turbo', label: 'Très précise', desc: 'Comprend presque tout, sur la carte graphique', sizeMB: 564, gpu: true },
}

export const PIPER_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'
export const SUPERTONIC_URL = 'https://huggingface.co/Supertone/supertonic-3/resolve/main'

/** Petite machine : voix et reconnaissance les plus légères pour garder l'ordinateur fluide. */
const isSmall = (hw: SystemInfo | null) => !!hw && (hw.ramGB <= 8 || hw.cores <= 4)
export const defaultVoice = (hw: SystemInfo | null): VoiceId => (isSmall(hw) ? 'fr_FR-gilles-low' : 'st-M2')
export const defaultStt = (hw: SystemInfo | null, webgpu: boolean): SttModel =>
  isSmall(hw) ? 'base' : webgpu && (hw?.ramGB ?? 16) >= 12 ? 'turbo' : 'small'

let gpu: Promise<boolean> | null = null
/** WebGPU utilisable (carte graphique accessible au navigateur, avec calcul 16 bits). */
export function hasWebGPU(): Promise<boolean> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }
  gpu ??= nav.gpu
    ? nav.gpu.requestAdapter().then(
        (a) => !!a && a.features.has('shader-f16'),
        () => false,
      )
    : Promise.resolve(false)
  return gpu
}

export type VoicePrefs = { voice: VoiceId | null; stt: SttModel | null; rate: number; lang: 'fr' | 'auto' } // null = choix automatique selon la machine
export const DEFAULT_VOICE_PREFS: VoicePrefs = { voice: null, stt: null, rate: 1, lang: 'fr' }
