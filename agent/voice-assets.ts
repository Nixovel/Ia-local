// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
/**
 * Fichiers des moteurs vocaux servis en local sous /vendor/… (rien n'est chargé depuis un CDN) :
 *  - /vendor/ort/   : onnxruntime-web (calcul des modèles en WebAssembly), partagé par Whisper, Piper et la détection de parole ;
 *  - /vendor/vad/   : Silero VAD (détecte quand on parle) et son AudioWorklet ;
 *  - /vendor/piper/ : phonémiseur de Piper (espeak-ng compilé en WebAssembly, avec ses données de langues).
 * En dev, un middleware lit les fichiers dans node_modules ; au build, ils sont copiés dans dist/vendor/.
 * Les modèles eux-mêmes (voix Piper, Whisper) sont téléchargés une fois depuis Hugging Face puis gardés en cache.
 */
import type { Connect, Plugin } from 'vite'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Liste blanche : seuls ces fichiers sont servis (pas de parcours de dossiers possible)
const MOUNTS: Record<string, { dir: string; files: RegExp }> = {
  // version standard (Piper, détection de parole) et « asyncify » (Whisper via transformers.js)
  ort: { dir: 'node_modules/onnxruntime-web/dist', files: /^ort-wasm-simd-threaded(\.asyncify)?\.(mjs|wasm)$/ },
  vad: { dir: 'node_modules/@ricky0123/vad-web/dist', files: /^(vad\.worklet\.bundle\.min\.js|silero_vad_(v5|legacy)\.onnx)$/ },
  piper: { dir: 'node_modules/@diffusionstudio/piper-wasm/build', files: /^piper_phonemize\.(js|wasm|data)$/ },
}

const TYPES: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.data': 'application/octet-stream',
}

const serve: Connect.NextHandleFunction = (req, res, next) => {
  const m = req.url?.match(/^\/vendor\/(ort|vad|piper)\/([^?#/]+)/)
  if (!m) return next()
  const mount = MOUNTS[m[1]]
  const name = decodeURIComponent(m[2])
  if (!mount.files.test(name)) return next()
  const file = path.join(ROOT, mount.dir, name)
  if (!existsSync(file)) return next()
  res.setHeader('Content-Type', TYPES[path.extname(name)] ?? 'application/octet-stream')
  res.setHeader('Content-Length', String(statSync(file).size))
  res.setHeader('Cache-Control', 'public, max-age=86400')
  // Les fils de calcul d'onnxruntime sont des workers chargés depuis ces fichiers : sans ces en-têtes,
  // une page isolée (multi-cœur) refuse de les démarrer et le moteur attend indéfiniment.
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  createReadStream(file).pipe(res)
}

export function voiceAssets(): Plugin {
  return {
    name: 'lumen-voice-assets',
    configureServer(server) {
      server.middlewares.use(serve)
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve)
    },
    generateBundle() {
      for (const [key, mount] of Object.entries(MOUNTS)) {
        const dir = path.join(ROOT, mount.dir)
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir).filter((f) => mount.files.test(f)))
          this.emitFile({ type: 'asset', fileName: `vendor/${key}/${name}`, source: readFileSync(path.join(dir, name)) })
      }
    },
  }
}
