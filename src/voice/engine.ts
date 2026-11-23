// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Côté interface des moteurs vocaux : le worker (Whisper + Piper), la lecture audio et le micro (détection de parole).
import type { SttModel, VoiceId } from './catalog'
import type { WorkerIn, WorkerOut } from './worker'
import { meter, useVoice } from './state'

// ---------- Worker ----------
type Done = Extract<WorkerOut, { type: 'done' }>
type Request = WorkerIn extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (d: Done) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'lumen-voix' })
  w.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data
    if (m.type === 'progress') {
      if (m.what === 'stt-upgrade') useVoice.setState({ upgrade: { loaded: m.loaded, total: m.total } })
      else useVoice.setState({ progress: { what: m.what, loaded: m.loaded, total: m.total } })
      return
    }
    if (m.type === 'stt-ready') {
      useVoice.setState({ sttModel: m.model, upgrade: null })
      return
    }
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.type === 'done') p.resolve(m)
    else p.reject(new Error(m.message))
  }
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Moteur vocal arrêté'))
    pending.clear()
    worker = null
  }
  worker = w
  return w
}

function call(req: Request, transfer: Transferable[] = []): Promise<Done> {
  const id = ++seq
  return new Promise<Done>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ ...req, id } as WorkerIn, transfer)
  })
}

export const loadStt = (model: SttModel, opt?: 'all' | 'extended' | 'basic' | 'disabled') =>
  call({ type: 'stt-load', model, opt }).finally(() => useVoice.setState({ progress: null }))
export const loadTts = (voice: VoiceId) => call({ type: 'tts-load', voice }).finally(() => useVoice.setState({ progress: null }))

/** Audio 16 kHz mono → texte. */
export async function transcribe(audio: Float32Array, lang: 'fr' | 'auto'): Promise<string> {
  return (await call({ type: 'transcribe', audio, lang }, [audio.buffer])).text ?? ''
}

/** Texte → audio (calculé dans le worker, phrase par phrase). */
export async function synth(text: string, rate: number): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const r = await call({ type: 'speak', text, rate })
  return { pcm: r.pcm!, sampleRate: r.sampleRate! }
}

/** Abandonne les phrases demandées mais pas encore calculées. */
export function cancelSpeech() {
  if (worker) worker.postMessage({ type: 'cancel', id: seq } satisfies WorkerIn)
}

// ---------- Lecture : les phrases s'enchaînent sans trou ----------
class Player {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private endAt = 0
  private raf = 0
  private buf = new Float32Array(512)

  /** À appeler pendant un clic : les navigateurs n'autorisent le son qu'après une action de l'utilisateur. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  get busy() {
    return this.sources.size > 0
  }

  /** Secondes d'audio déjà programmées et pas encore jouées. */
  remaining(): number {
    return this.ctx && this.sources.size ? Math.max(0, this.endAt - this.ctx.currentTime) : 0
  }

  /** Programme la phrase juste après la précédente ; `onStart` quand elle commence vraiment, la promesse à sa fin. */
  play(pcm: Float32Array, sampleRate: number, onStart?: () => void): Promise<void> {
    const ctx = this.unlock()
    const audio = ctx.createBuffer(1, pcm.length, sampleRate)
    audio.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
    const src = ctx.createBufferSource()
    src.buffer = audio
    src.connect(this.analyser!)
    // Petite respiration entre deux morceaux
    const start = Math.max(ctx.currentTime + 0.02, this.endAt ? this.endAt + 0.07 : 0)
    src.start(start)
    this.endAt = start + audio.duration
    this.sources.add(src)
    this.watch()
    if (onStart) setTimeout(onStart, Math.max(0, (start - ctx.currentTime) * 1000))
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(guard)
        this.sources.delete(src)
        if (!this.sources.size) this.endAt = 0
        resolve()
      }
      src.onended = finish
      // Filet de sécurité (son bloqué par le navigateur, sortie audio débranchée) : la conversation ne reste jamais figée
      const guard = setTimeout(finish, (start - ctx.currentTime + audio.duration) * 1000 + 1500)
    })
  }

  stop() {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* déjà arrêtée */
      }
    }
    this.sources.clear()
    this.endAt = 0
  }

  /** Niveau de la voix pour l'animation, tant que quelque chose joue. */
  private watch() {
    if (this.raf) return
    const tick = () => {
      if (!this.sources.size || !this.analyser) {
        this.raf = 0
        meter.level = 0
        return
      }
      this.analyser.getFloatTimeDomainData(this.buf)
      let sum = 0
      for (const v of this.buf) sum += v * v
      meter.level = Math.min(1, Math.sqrt(sum / this.buf.length) * 4)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }
}

export const player = new Player()
