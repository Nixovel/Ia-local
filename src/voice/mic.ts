// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Micro : Silero VAD détecte le début et la fin de chaque phrase. Chargé au premier usage seulement
// (c'est la partie la plus lourde), pour que l'application démarre aussi vite qu'avant.
import { MicVAD } from '@ricky0123/vad-web'
import { meter } from './state'

let vad: MicVAD | null = null

export async function startMic(cb: { onStart: () => void; onEnd: (audio: Float32Array) => void; onMisfire: () => void }) {
  if (vad) {
    await vad.start()
    return
  }
  const created = await MicVAD.new({
    model: 'v5',
    baseAssetPath: '/vendor/vad/',
    onnxWASMBasePath: '/vendor/ort/',
    ortConfig: (ort) => {
      ort.env.logLevel = 'error'
      ort.env.wasm.numThreads = 1 // modèle minuscule : un seul fil suffit
    },
    startOnLoad: false,
    // Seuils un peu stricts : les bruits courts ne déclenchent rien ; ~0,8 s de silence termine la phrase
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.4,
    redemptionMs: 800,
    preSpeechPadMs: 300,
    minSpeechMs: 350,
    onSpeechStart: cb.onStart,
    onSpeechEnd: cb.onEnd,
    onVADMisfire: cb.onMisfire,
    onFrameProcessed: (_p, frame) => {
      let sum = 0
      for (const v of frame) sum += v * v
      meter.level = Math.min(1, Math.sqrt(sum / frame.length) * 6)
    },
  })
  try {
    await created.start()
  } catch (e) {
    await Promise.race([created.destroy().catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
    throw e
  }
  vad = created
}

export async function pauseMic() {
  await vad?.pause()
  meter.level = 0
}

export async function resumeMic() {
  await vad?.start()
}

export async function stopMic() {
  const v = vad
  vad = null
  meter.level = 0
  // destroy() peut attendre indéfiniment si le micro n'a jamais été ouvert (accès refusé) : on ne bloque pas dessus
  await Promise.race([v?.destroy().catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
}
