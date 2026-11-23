// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Moteurs vocaux dans un worker : la reconnaissance (Whisper) et la voix (Piper) calculent ici,
// jamais dans le fil de l'interface, qui reste fluide. Tout tourne en local (WebAssembly, processeur).
import { env, pipeline } from '@huggingface/transformers'
import * as ort from 'onnxruntime-web/wasm'
import { PIPER_URL, STT, SUPERTONIC_URL, VOICES, voiceInfo, type SttModel, type VoiceId } from './catalog'

export type WorkerIn =
  | { type: 'stt-load'; id: number; model: SttModel; opt?: 'all' | 'extended' | 'basic' | 'disabled' }
  | { type: 'transcribe'; id: number; audio: Float32Array; lang: 'fr' | 'auto' }
  | { type: 'tts-load'; id: number; voice: VoiceId }
  | { type: 'speak'; id: number; text: string; rate: number }
  | { type: 'cancel'; id: number } // abandonne les phrases pas encore calculées (interruption)

export type WorkerOut =
  | { type: 'progress'; what: 'stt' | 'stt-upgrade' | 'tts'; loaded: number; total: number }
  | { type: 'stt-ready'; model: SttModel } // le modèle le plus précis a pris le relais
  | { type: 'done'; id: number; text?: string; pcm?: Float32Array; sampleRate?: number }
  | { type: 'error'; id: number; message: string }

const ctx = self as unknown as { postMessage(m: WorkerOut, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<WorkerIn>) => void) | null }

// Calcul : 1 thread sans isolation cross-origin ; sinon la moitié des cœurs (4 au plus) pour laisser respirer le reste.
const THREADS = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated
  ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
  : 1

ort.env.wasm.wasmPaths = '/vendor/ort/'
ort.env.wasm.numThreads = THREADS
env.allowLocalModels = false
const onnxWasm = (env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }).wasm
if (onnxWasm) {
  onnxWasm.wasmPaths = { mjs: '/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', wasm: '/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm' }
  onnxWasm.numThreads = THREADS
}

// ---------- Téléchargement avec cache (une seule fois par modèle) ----------
const CACHE = 'lumen-voice-v1'

async function cachedBuffer(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(url)
  if (hit) return hit.arrayBuffer()
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status}) : ${url.split('/').pop()}`)
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress?.(loaded, total)
  }
  const blob = new Blob(chunks as BlobPart[])
  await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }))
  return blob.arrayBuffer()
}

// ---------- Reconnaissance : Whisper ----------
// Optimisation « basic » des graphes : chargement ~20 fois plus rapide (1 s au lieu de 26 pour « small »),
// sans ralentir la transcription.
type Transcriber = ((audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>) & {
  dispose?: () => Promise<void>
}
type Slot = { model: SttModel; ready: Promise<Transcriber> }
let stt: Slot | null = null // celui qui transcrit maintenant
let upgrade: Slot | null = null // le plus précis, qui se prépare en arrière-plan (carte graphique)
let sttOpt: 'all' | 'extended' | 'basic' | 'disabled' = 'basic'

function createStt(model: SttModel, report: boolean): Promise<Transcriber> {
  const files = new Map<string, { loaded: number; total: number }>()
  const gpu = !!STT[model].gpu
  return pipeline('automatic-speech-recognition', STT[model].repo, {
    // large-v3-turbo sur la carte graphique (WebGPU, 4 bits) ; les autres sur le processeur (8 bits)
    device: gpu ? 'webgpu' : 'wasm',
    dtype: gpu ? { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' } : { encoder_model: 'q8', decoder_model_merged: 'q8' },
    session_options: { graphOptimizationLevel: sttOpt },
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file) return
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 })
      let loaded = 0
      let total = 0
      for (const f of files.values()) {
        loaded += f.loaded
        total += f.total
      }
      ctx.postMessage({ type: 'progress', what: report ? 'stt' : 'stt-upgrade', loaded, total })
    },
  }) as unknown as Promise<Transcriber>
}

/**
 * Prépare la reconnaissance. Le modèle « turbo » (carte graphique) met ~30 s à s'initialiser : on démarre alors
 * tout de suite avec « small » (1 s) et « turbo » prend le relais tout seul dès qu'il est prêt, sans bloquer
 * la voix ni la transcription en cours.
 */
function loadStt(model: SttModel): Promise<Transcriber> {
  if (stt?.model === model) return stt.ready
  if (STT[model].gpu) {
    // Les sessions sont créées une par une (transformers.js) : « small » d'abord, « turbo » ensuite
    if (!stt) {
      const quick = loadStt('small')
      void quick.finally(() => loadStt(model))
      return quick
    }
    if (!upgrade || upgrade.model !== model) {
      const slot: Slot = { model, ready: createStt(model, false) }
      upgrade = slot
      slot.ready.then(
        (t) => {
          if (upgrade !== slot) return void t.dispose?.()
          const old = stt
          stt = slot
          upgrade = null
          ctx.postMessage({ type: 'stt-ready', model })
          void old?.ready.then((o) => o.dispose?.()).catch(() => {})
        },
        () => {
          if (upgrade === slot) upgrade = null
          ctx.postMessage({ type: 'stt-ready', model: stt?.model ?? 'small' })
        },
      )
    }
    return stt.ready
  }
  const slot: Slot = { model, ready: createStt(model, true) }
  const old = stt
  stt = slot
  slot.ready.then(() => void old?.ready.then((o) => o.dispose?.()).catch(() => {}), () => stt === slot && (stt = null))
  return slot.ready
}

// ---------- Voix : Piper (phonémiseur espeak-ng + modèle VITS) ----------
type PiperConfig = { audio: { sample_rate: number }; espeak: { voice: string }; inference: { noise_scale: number; length_scale: number; noise_w: number }; num_speakers?: number }
type EmModule = { callMain(args: string[]): void }
type CreatePhonemize = (opts: Record<string, unknown>) => Promise<EmModule>

let phonemizer: Promise<{ create: CreatePhonemize; wasm: WebAssembly.Module; data: ArrayBuffer }> | null = null

/** Charge une fois le phonémiseur (code, WebAssembly compilé et données des langues), réutilisé pour chaque phrase. */
function getPhonemizer() {
  phonemizer ??= (async () => {
    const [code, wasm, data] = await Promise.all([
      fetch('/vendor/piper/piper_phonemize.js').then((r) => r.text()),
      WebAssembly.compileStreaming(fetch('/vendor/piper/piper_phonemize.wasm')),
      fetch('/vendor/piper/piper_phonemize.data').then((r) => r.arrayBuffer()),
    ])
    // Module Emscripten publié en CommonJS : on l'évalue avec un `module` local pour récupérer la fabrique.
    const mod: { exports: unknown } = { exports: {} }
    new Function('module', 'exports', code)(mod, mod.exports)
    return { create: mod.exports as CreatePhonemize, wasm, data }
  })().catch((e) => {
    phonemizer = null
    throw e
  })
  return phonemizer
}

async function phonemize(text: string, voice: string): Promise<number[]> {
  const { create, wasm, data } = await getPhonemizer()
  let ids: number[] | null = null
  const m = await create({
    print: (line: string) => {
      try {
        ids = (JSON.parse(line) as { phoneme_ids: number[] }).phoneme_ids
      } catch {
        /* autre sortie */
      }
    },
    printErr: () => {},
    locateFile: (f: string) => `/vendor/piper/${f}`,
    getPreloadedPackage: () => data,
    instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
      void WebAssembly.instantiate(wasm, imports).then((inst) => done(inst, wasm))
      return {}
    },
  })
  m.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data'])
  if (!ids) throw new Error('Phonémisation impossible')
  return ids
}

type Audio = { pcm: Float32Array; sampleRate: number }
type Synth = (text: string, rate: number) => Promise<Audio>

let tts: { voice: VoiceId; ready: Promise<Synth> } | null = null
const ttsProgress = (loaded: number, total: number) => ctx.postMessage({ type: 'progress', what: 'tts', loaded, total })

function loadTts(voice: VoiceId): Promise<Synth> {
  if (tts?.voice === voice) return tts.ready
  const v = voiceInfo(voice)
  const ready = (v.engine === 'supertonic' ? loadSupertonicVoice(v.style ?? 'M1') : loadPiper(v)).then(async (synth) => {
    // Préchauffage : la toute première phrase calculée est plus lente (allocations) ; on la fait maintenant, en silence.
    await synth('Bonjour.', 1).catch(() => {})
    return synth
  })
  tts = { voice, ready }
  ready.catch(() => (tts = null))
  return ready
}

// ---------- Piper : voix légère (petits PC) ----------
let piper: { id: string; session: ort.InferenceSession; config: PiperConfig } | null = null

async function loadPiper(v: ReturnType<typeof voiceInfo>): Promise<Synth> {
  if (piper?.id !== v.id) {
    const base = `${PIPER_URL}/${v.path}/${v.id}.onnx`
    const [config, model] = await Promise.all([
      cachedBuffer(`${base}.json`).then((b) => JSON.parse(new TextDecoder().decode(b)) as PiperConfig),
      cachedBuffer(base, ttsProgress),
      getPhonemizer(),
    ])
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    void piper?.session.release().catch(() => {})
    piper = { id: v.id, session, config }
  }
  const { session, config } = piper
  return (text, rate) => piperSynth(session, config, text, rate)
}

async function piperSynth(session: ort.InferenceSession, config: PiperConfig, text: string, rate: number): Promise<Audio> {
  const ids = await phonemize(text, config.espeak.voice)
  const big = (n: number[]) => BigInt64Array.from(n, (x) => BigInt(x))
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', big(ids), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', big([ids.length]), [1]),
    // length_scale < 1 : débit plus rapide
    scales: new ort.Tensor('float32', Float32Array.from([config.inference.noise_scale, config.inference.length_scale / rate, config.inference.noise_w]), [3]),
  }
  if ((config.num_speakers ?? 1) > 1) feeds.sid = new ort.Tensor('int64', big([0]), [1])
  const out = await session.run(feeds)
  const pcm = new Float32Array(out.output.data as Float32Array) // copie : son tampon peut être transféré à l'interface
  return { pcm, sampleRate: config.audio.sample_rate }
}

// ---------- Supertonic 3 : voix naturelle (flow matching, 4 modèles ONNX, lit directement le texte) ----------
type StConfig = { ae: { sample_rate: number; base_chunk_size: number }; ttl: { chunk_compress_factor: number; latent_dim: number } }
type StEngine = { cfg: StConfig; indexer: number[]; dp: ort.InferenceSession; enc: ort.InferenceSession; vec: ort.InferenceSession; voc: ort.InferenceSession }
type StStyle = { ttl: ort.Tensor; dp: ort.Tensor }

let supertonic: Promise<StEngine> | null = null
const stStyles = new Map<string, Promise<StStyle>>()
const ST_STEPS = 8 // étapes de débruitage : 8 = qualité recommandée par Supertone

function loadSupertonic(): Promise<StEngine> {
  supertonic ??= (async () => {
    // Téléchargement des 4 modèles en parallèle, progression cumulée
    const parts = new Map<string, { loaded: number; total: number }>()
    const report = (name: string) => (loaded: number, total: number) => {
      parts.set(name, { loaded, total })
      let l = 0
      let t = 0
      for (const p of parts.values()) {
        l += p.loaded
        t += p.total
      }
      ttsProgress(l, t)
    }
    const names = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'] as const
    const [cfgBuf, idxBuf, ...models] = await Promise.all([
      cachedBuffer(`${SUPERTONIC_URL}/onnx/tts.json`),
      cachedBuffer(`${SUPERTONIC_URL}/onnx/unicode_indexer.json`),
      ...names.map((n) => cachedBuffer(`${SUPERTONIC_URL}/onnx/${n}.onnx`, report(n))),
    ])
    const dec = new TextDecoder()
    const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
    // Sessions créées une par une : moins de pic de mémoire
    const sessions: ort.InferenceSession[] = []
    for (const m of models) sessions.push(await ort.InferenceSession.create(new Uint8Array(m), opts))
    const [dp, enc, vec, voc] = sessions
    return { cfg: JSON.parse(dec.decode(cfgBuf)) as StConfig, indexer: JSON.parse(dec.decode(idxBuf)) as number[], dp, enc, vec, voc }
  })().catch((e) => {
    supertonic = null
    throw e
  })
  return supertonic
}

function stStyle(name: string): Promise<StStyle> {
  let p = stStyles.get(name)
  if (!p) {
    p = cachedBuffer(`${SUPERTONIC_URL}/voice_styles/${name}.json`).then((b) => {
      type T = { dims: number[]; data: unknown[] }
      const j = JSON.parse(new TextDecoder().decode(b)) as { style_ttl: T; style_dp: T }
      const tensor = (t: T) => new ort.Tensor('float32', Float32Array.from(t.data.flat(Infinity) as number[]), t.dims)
      return { ttl: tensor(j.style_ttl), dp: tensor(j.style_dp) }
    })
    p.catch(() => stStyles.delete(name))
    stStyles.set(name, p)
  }
  return p
}

async function loadSupertonicVoice(style: string): Promise<Synth> {
  const [engine, s] = await Promise.all([loadSupertonic(), stStyle(style)])
  return (text, rate) => stSynth(engine, s, text, rate)
}

/** Nettoyage du texte attendu par Supertonic (repris de l'exemple officiel), balisé avec la langue. */
function stPrepare(text: string, lang: string): string {
  let t = text.normalize('NFKD').replace(/\p{Extended_Pictographic}/gu, '')
  const map: Record<string, string> = { '–': '-', '‑': '-', '—': '-', _: ' ', '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ' }
  for (const [k, v] of Object.entries(map)) t = t.replaceAll(k, v)
  t = t.replace(/[♥☆♡©\\]/g, '').replace(/ ([,.!?;:'])/g, '$1').replace(/"{2,}/g, '"').replace(/'{2,}/g, "'").replace(/\s+/g, ' ').trim()
  if (!/[.!?;:,'")\]}…»]$/.test(t)) t += '.'
  return `<${lang}>${t}</${lang}>`
}

/** Bruit gaussien (Box-Muller). */
function gaussian(n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(1e-4, Math.random())
    const u2 = Math.random()
    const r = Math.sqrt(-2 * Math.log(u1))
    out[i] = r * Math.cos(2 * Math.PI * u2)
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2)
  }
  return out
}

async function stSynth(e: StEngine, style: StStyle, text: string, rate: number): Promise<Audio> {
  const prepared = stPrepare(text, 'fr')
  const ids = new BigInt64Array(prepared.length)
  for (let j = 0; j < prepared.length; j++) {
    const cp = prepared.codePointAt(j)!
    ids[j] = BigInt(cp < e.indexer.length ? e.indexer[cp] : -1)
  }
  const len = prepared.length
  const textIds = new ort.Tensor('int64', ids, [1, len])
  const textMask = new ort.Tensor('float32', new Float32Array(len).fill(1), [1, 1, len])

  // 1. Durée de la phrase
  const { duration } = await e.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask })
  const seconds = (duration.data as Float32Array)[0] / (1.05 * rate)
  // 2. Texte encodé avec le style de la voix
  const { text_emb } = await e.enc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask })
  // 3. Débruitage (flow matching) d'un latent aléatoire
  const sr = e.cfg.ae.sample_rate
  const chunk = e.cfg.ae.base_chunk_size * e.cfg.ttl.chunk_compress_factor
  const dim = e.cfg.ttl.latent_dim * e.cfg.ttl.chunk_compress_factor
  const wavLen = Math.floor(seconds * sr)
  const frames = Math.max(1, Math.ceil(wavLen / chunk))
  let xt = gaussian(dim * frames)
  const latentMask = new ort.Tensor('float32', new Float32Array(frames).fill(1), [1, 1, frames])
  const totalStep = new ort.Tensor('float32', Float32Array.of(ST_STEPS), [1])
  for (let step = 0; step < ST_STEPS; step++) {
    const out = await e.vec.run({
      noisy_latent: new ort.Tensor('float32', xt, [1, dim, frames]),
      text_emb,
      style_ttl: style.ttl,
      latent_mask: latentMask,
      text_mask: textMask,
      current_step: new ort.Tensor('float32', Float32Array.of(step), [1]),
      total_step: totalStep,
    })
    xt = new Float32Array(out.denoised_latent.data as Float32Array)
  }
  // 4. Latent → son
  const { wav_tts } = await e.voc.run({ latent: new ort.Tensor('float32', xt, [1, dim, frames]) })
  const wav = wav_tts.data as Float32Array
  return { pcm: new Float32Array(wav.subarray(0, Math.min(wav.length, wavLen))), sampleRate: sr }
}

async function speak(text: string, rate: number): Promise<Audio> {
  const synth = await (tts?.ready ?? loadTts(VOICES[0].id))
  const audio = await synth(text, rate)
  // Volume homogène d'une voix et d'une phrase à l'autre (crête ramenée vers 0,7, gain limité à ×3)
  let peak = 0
  for (const v of audio.pcm) peak = Math.max(peak, Math.abs(v))
  if (peak > 0.01) {
    const gain = Math.min(3, 0.7 / peak)
    for (let i = 0; i < audio.pcm.length; i++) audio.pcm[i] *= gain
  }
  return audio
}

// ---------- Messages ----------
// Les tâches passent une par une : la voix et la reconnaissance ne se disputent jamais le processeur.
let queue: Promise<unknown> = Promise.resolve()
let skipSpeakUpTo = 0

ctx.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    skipSpeakUpTo = msg.id
    return
  }
  queue = queue.then(async () => {
    if (msg.type === 'speak' && msg.id <= skipSpeakUpTo) {
      ctx.postMessage({ type: 'error', id: msg.id, message: 'annulé' })
      return
    }
    try {
      if (msg.type === 'stt-load') {
        if (msg.opt && msg.opt !== sttOpt) {
          sttOpt = msg.opt
          stt = null
        }
        await loadStt(msg.model)
        ctx.postMessage({ type: 'stt-ready', model: stt?.model ?? msg.model })
        ctx.postMessage({ type: 'done', id: msg.id })
      } else if (msg.type === 'tts-load') {
        await loadTts(msg.voice)
        ctx.postMessage({ type: 'done', id: msg.id })
      } else if (msg.type === 'transcribe') {
        const run = await (stt?.ready ?? loadStt('base'))
        const out = await run(msg.audio, { ...(msg.lang === 'fr' ? { language: 'french' } : {}), task: 'transcribe', chunk_length_s: 30 })
        const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim()
        ctx.postMessage({ type: 'done', id: msg.id, text })
      } else if (msg.type === 'speak') {
        const { pcm, sampleRate } = await speak(msg.text, msg.rate)
        ctx.postMessage({ type: 'done', id: msg.id, pcm, sampleRate }, [pcm.buffer])
      }
    } catch (err) {
      ctx.postMessage({ type: 'error', id: msg.id, message: (err as Error).message || String(err) })
    }
  })
}
