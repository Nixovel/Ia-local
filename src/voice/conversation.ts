// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Conversation vocale façon Jarvis : on parle → Whisper transcrit → le modèle répond → Piper lit la réponse
// phrase par phrase pendant qu'elle s'écrit → Lumen se remet à écouter. Sans clavier.
import { toast, useStore } from '../store'
import { send, stop as stopGeneration } from '../chat'
import { fetchHardware } from '../lib/hardware'
import { defaultStt, defaultVoice, DEFAULT_VOICE_PREFS, hasWebGPU, type SttModel, type VoiceId } from './catalog'
import { cancelSpeech, loadStt, loadTts, player, synth, transcribe } from './engine'
import { SpeechChunker } from './speakable'
import { useVoice, type VoicePhase } from './state'

// Micro (détection de parole, la partie la plus lourde) : chargé au premier usage seulement.
const mic = () => import('./mic')

const set = (p: Partial<ReturnType<typeof useVoice.getState>>) => useVoice.setState(p)
const phase = () => useVoice.getState().phase

async function prefs(): Promise<{ voice: VoiceId; stt: SttModel; rate: number; lang: 'fr' | 'auto' }> {
  const p = { ...DEFAULT_VOICE_PREFS, ...useStore.getState().voice }
  const hw = p.voice && p.stt ? null : await fetchHardware().catch(() => null)
  const gpu = await hasWebGPU()
  // « Très précise » demande la carte graphique : sans WebGPU, on se rabat sur « Précise »
  const stt = p.stt === 'turbo' && !gpu ? 'small' : (p.stt ?? defaultStt(hw, gpu))
  return { voice: p.voice ?? defaultVoice(hw), stt, rate: p.rate, lang: p.lang }
}

// ---------- File de parole : phrases → voix (worker) → haut-parleur, sans trou ----------
class Speaker {
  private chain: Promise<void> = Promise.resolve()
  private last: Promise<void> = Promise.resolve()
  private gen = 0
  private pending = 0 // morceaux demandés, pas encore programmés

  /** Ajoute une phrase : son calcul démarre tout de suite, sa lecture suit la précédente. `onStart(durée en s)`. */
  say(text: string, rate: number, onStart?: (seconds: number) => void) {
    const g = this.gen
    const job = synth(text, rate)
    job.catch(() => {})
    this.pending++
    this.chain = this.chain.then(async () => {
      let audio: Awaited<typeof job>
      try {
        audio = await job
      } catch {
        return // phrase annulée ou impossible à dire : on passe à la suivante
      } finally {
        this.pending--
      }
      if (g !== this.gen) return
      const seconds = audio.pcm.length / audio.sampleRate
      this.last = player.play(audio.pcm, audio.sampleRate, () => g === this.gen && onStart?.(seconds))
    })
  }

  /** La voix va manquer de texte : plus rien en préparation et moins d'une seconde d'audio programmée. */
  hungry() {
    return this.pending === 0 && player.remaining() < 1
  }

  /** Résolue quand tout ce qui a été demandé a été dit (ou annulé). */
  async idle() {
    let before: Promise<void>
    do {
      before = this.chain
      await before
      await this.last
    } while (before !== this.chain)
  }

  cancel() {
    this.gen++
    cancelSpeech()
    player.stop()
  }
}

const speaker = new Speaker()
let active = false

// Ce que Whisper « entend » parfois dans le silence ou le bruit
const HALLUCINATION =
  /sous-titr|amara\.org|merci d'avoir regardé|abonnez-vous|(prochaine|autre|cette) vidéo|à la prochaine|^\W*$|^\[.*\]$|^\(.*\)$|^(musique|rires?|applaudissements|merci)\.?$/i

const clean = (t: string) => {
  const s = t.replace(/\s+/g, ' ').trim()
  return HALLUCINATION.test(s) ? '' : s
}

// « stop », « arrête », « au revoir »… seul : fin de la conversation vocale
const BYE = /^(stop|arr[êe]te[sz]?|tais-toi|silence|au revoir|bonne nuit|fin de la conversation|c'est (tout|bon) merci)[\s.!]*$/i

export async function startConversation() {
  if (active) return
  active = true
  player.unlock() // pendant le clic : le navigateur autorise alors le son
  set({ phase: 'loading', error: null, heard: '', saying: '', micMuted: false })
  try {
    const p = await prefs()
    const [m] = await Promise.all([mic(), loadStt(p.stt), loadTts(p.voice)])
    if (!active) return
    await m.startMic({
      onStart: () => phase() === 'listening' && set({ phase: 'hearing' }),
      onMisfire: () => phase() === 'hearing' && set({ phase: 'listening' }),
      onEnd: (audio) => void onUtterance(audio),
    })
    if (!active) return void m.stopMic()
    set({ phase: 'listening', progress: null })
  } catch (e) {
    const msg = (e as Error).message || String(e)
    const denied = /permission|notallowed|denied|notfound|not found|device/i.test(msg)
    const error = denied
      ? 'Micro indisponible : autorisez le micro pour Lumen dans votre navigateur (Chrome, Safari, Edge…), puis réessayez.'
      : `Voix indisponible : ${msg}`
    set({ error })
    toast(error, 'danger')
    await stopConversation(true)
  }
}

async function onUtterance(audio: Float32Array) {
  if (!active || !(['listening', 'hearing'] as VoicePhase[]).includes(phase())) return
  await (await mic()).pauseMic()
  set({ phase: 'transcribing' })
  const p = await prefs()
  let text = ''
  try {
    text = clean(await transcribe(audio, p.lang))
  } catch (e) {
    toast(`Transcription impossible : ${(e as Error).message}`, 'danger')
  }
  if (!active) return
  if (!text) return listenAgain()
  set({ heard: text, saying: '' })
  if (BYE.test(text)) {
    speaker.say('À bientôt.', p.rate)
    await speaker.idle()
    return stopConversation()
  }
  set({ phase: 'thinking' })
  await answer(text, p.rate)
  if (active) await listenAgain()
}

async function listenAgain() {
  if (!active) return
  set({ phase: 'listening', saying: '' })
  if (!useVoice.getState().micMuted) await (await mic()).resumeMic()
}

/** Envoie la phrase au modèle et lit sa réponse au fil de l'écriture (étapes d'outils comprises). */
async function answer(text: string, rate: number) {
  const st = useStore.getState()
  const before = new Set((st.activeId ? st.conversations[st.activeId]?.messages : [])?.map((m) => m.id))
  const chunkers = new Map<string, SpeechChunker>()
  const errored = new Set<string>()
  // Le texte de la réponse s'affiche au rythme de la voix : rien tant qu'elle n'a pas commencé, puis passage par passage
  const reveal = (id: string, r: { from: number; to: number; at: number; dur: number }) =>
    active && set({ reveal: { ...useVoice.getState().reveal, [id]: r } })

  const follow = (final: boolean) => {
    const s = useStore.getState()
    const conv = s.activeId ? s.conversations[s.activeId] : null
    if (!conv) return
    for (const m of conv.messages) {
      if (m.role !== 'assistant' || before.has(m.id)) continue
      let ch = chunkers.get(m.id)
      if (!ch) {
        chunkers.set(m.id, (ch = new SpeechChunker()))
        reveal(m.id, { from: 0, to: 0, at: 0, dur: 0 })
      }
      for (const c of ch.feed(m.content || '', final || !m.streaming, speaker.hungry()))
        speaker.say(c.text, rate, (dur) => {
          if (!active) return
          set({ phase: 'speaking', saying: c.text })
          reveal(m.id, { from: c.from, to: c.to, at: performance.now(), dur })
        })
      if (m.error && !errored.has(m.id)) {
        errored.add(m.id)
        speaker.say('Désolé, je n’ai pas pu répondre.', rate, () => active && set({ phase: 'speaking', saying: 'Désolé, je n’ai pas pu répondre.' }))
      }
    }
  }
  const unsub = useStore.subscribe(() => follow(false))
  try {
    // Réflexion coupée en mode « Auto » : à l'oral, la réponse doit venir vite
    const think = useStore.getState().settingsFor(useStore.getState().selectedModel).think === 'on' ? undefined : false
    await send(text, { think })
  } finally {
    unsub()
  }
  follow(true)
  await speaker.idle()
  set({ reveal: {} }) // tout a été dit : le texte complet reste affiché
}

/** Coupe la parole : arrête la voix et la génération en cours, puis réécoute. */
export function interrupt() {
  speaker.cancel()
  set({ reveal: {} })
  const s = useStore.getState()
  if (s.activeId && s.streaming[s.activeId]) stopGeneration(s.activeId)
}

export async function stopConversation(keepError = false) {
  active = false
  speaker.cancel()
  set({ phase: 'off', progress: null, saying: '', reveal: {}, ...(keepError ? {} : { error: null }) })
  await (await mic()).stopMic()
}

export async function toggleMic() {
  const muted = !useVoice.getState().micMuted
  set({ micMuted: muted })
  const m = await mic()
  if (muted) await m.pauseMic()
  else if (phase() === 'listening') await m.resumeMic()
}

// ---------- « Écouter » : lit un message à voix haute ----------
export async function readAloud(msgId: string, content: string) {
  const v = useVoice.getState()
  speaker.cancel()
  if (v.readingId === msgId) return set({ readingId: null, readingLoading: false })
  if (v.phase !== 'off') return
  player.unlock()
  set({ readingId: msgId, readingLoading: true })
  try {
    const p = await prefs()
    await loadTts(p.voice)
    if (useVoice.getState().readingId !== msgId) return
    set({ readingLoading: false })
    for (const c of new SpeechChunker().feed(content, true)) speaker.say(c.text, p.rate)
    await speaker.idle()
  } catch (e) {
    toast(`Lecture impossible : ${(e as Error).message}`, 'danger')
  } finally {
    if (useVoice.getState().readingId === msgId) set({ readingId: null, readingLoading: false })
  }
}

/** Télécharge et prépare les modèles vocaux à l'avance (Réglages). */
export async function prepareVoice(): Promise<void> {
  const p = await prefs()
  await loadTts(p.voice)
  await loadStt(p.stt)
}

/** Fait entendre une voix (Réglages). */
export async function previewVoice(voice: VoiceId, rate: number) {
  speaker.cancel()
  player.unlock()
  await loadTts(voice)
  speaker.say('Bonjour, je suis Lumen. Que puis-je faire pour vous ?', rate)
  await speaker.idle()
}
