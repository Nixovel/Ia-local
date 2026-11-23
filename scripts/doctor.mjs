#!/usr/bin/env node
// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Vérifie que Lumen est prêt sur cette machine (macOS, Windows, Linux) et que l'IA répond vraiment.
//   npm run doctor        (ou « lumen doctor »)      --quiet : résumé court
// Ne modifie rien. Code de sortie 1 si un élément indispensable manque.
import { existsSync, statfsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const quiet = process.argv.includes('--quiet')
const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
let failed = 0

const ok = (label, detail = '') => console.log(`  ${c(32, '✓')} ${label}${detail ? c(2, ` — ${detail}`) : ''}`)
const warn = (label, fix) => console.log(`  ${c(33, '!')} ${label}${fix ? `\n      ${c(2, fix)}` : ''}`)
const fail = (label, fix) => {
  failed++
  console.log(`  ${c(31, '✗')} ${label}${fix ? `\n      ${c(2, `→ ${fix}`)}` : ''}`)
}
const get = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? 4000) })
const gb = (b) => (b / 2 ** 30).toFixed(1).replace('.', ',')

const osName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] ?? process.platform
console.log(`\n${c('1;38;5;215', 'Lumen — vérification')} ${c(2, `${osName} · ${process.arch} · ${gb(os.totalmem())} Go de RAM · ${os.cpus().length} cœurs`)}\n`)

// 1. Node.js
const [major, minor] = process.versions.node.split('.').map(Number)
if (major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19)) ok(`Node.js ${process.version}`)
else fail(`Node.js ${process.version} trop ancien (20.19+ ou 22.12+ requis)`, 'Relancez l’installateur : il installe une version récente sans droits administrateur.')

// 2. Dépendances et build
const need = ['vite', 'react', '@huggingface/transformers', 'onnxruntime-web', '@ricky0123/vad-web', '@diffusionstudio/piper-wasm']
const missing = need.filter((p) => !existsSync(path.join(ROOT, 'node_modules', p, 'package.json')))
if (missing.length) fail(`Dépendances manquantes : ${missing.join(', ')}`, 'npm ci (dans le dossier de Lumen)')
else ok('Dépendances installées')
if (existsSync(path.join(ROOT, 'dist', 'index.html'))) ok('Application construite', 'dist/')
else fail('Application pas encore construite', 'npm run build')

// 3. Moteurs vocaux servis en local (la voix fonctionne ensuite hors ligne)
const voiceFiles = [
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
  'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.data',
  'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx',
]
const voiceMissing = voiceFiles.filter((f) => !existsSync(path.join(ROOT, f)))
if (voiceMissing.length) fail('Fichiers des moteurs vocaux manquants', 'npm ci')
else if (!quiet) ok('Moteurs vocaux présents', 'reconnaissance, voix et détection de parole')

// 4. Espace disque (modèles d'IA : 1 à 20 Go chacun)
try {
  const st = statfsSync(os.homedir())
  const free = Number(st.bavail) * Number(st.bsize)
  if (free < 5 * 2 ** 30) warn(`Seulement ${gb(free)} Go libres`, 'Les modèles d’IA demandent de la place : libérez de l’espace disque.')
  else if (!quiet) ok(`${gb(free)} Go libres sur le disque`)
} catch {
  /* statfs indisponible */
}

// 5. Ollama et modèles
let models = []
try {
  const v = await (await get(`${OLLAMA}/api/version`)).json()
  ok(`Ollama ${v.version} répond`, OLLAMA)
  models = ((await (await get(`${OLLAMA}/api/tags`)).json()).models ?? []).filter(
    (m) => !/embed/i.test(m.name) && !(m.capabilities?.length && m.capabilities.every((cap) => cap === 'embedding')),
  )
  if (!models.length) warn('Aucun modèle d’IA installé', 'Ouvrez Lumen : l’assistant propose des modèles adaptés à votre PC (ou « ollama pull qwen3:4b »).')
  else ok(`${models.length} modèle(s) installé(s)`, models.slice(0, 4).map((m) => m.name).join(', ') + (models.length > 4 ? '…' : ''))
} catch {
  const how =
    process.platform === 'darwin'
      ? 'Ouvrez l’application Ollama (ou « ollama serve »). Pas installé ? https://ollama.com/download'
      : process.platform === 'win32'
        ? 'Lancez Ollama depuis le menu Démarrer. Pas installé ? Relancez install.ps1 ou https://ollama.com/download'
        : 'sudo systemctl start ollama (ou « ollama serve »). Pas installé ? curl -fsSL https://ollama.com/install.sh | sh'
  fail(`Ollama ne répond pas sur ${OLLAMA}`, how)
}

// 6. L'IA répond-elle vraiment ? (le plus petit modèle installé, réponse de quelques mots)
if (models.length) {
  const m = [...models].sort((a, b) => a.size - b.size)[0]
  try {
    const t = Date.now()
    const r = await get(`${OLLAMA}/api/chat`, {
      method: 'POST',
      timeout: 180_000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m.name,
        stream: false,
        think: false,
        messages: [{ role: 'user', content: 'Réponds uniquement par le mot : OK' }],
        options: { num_predict: 12, temperature: 0 },
      }),
    })
    const j = await r.json()
    if (!r.ok || j.error) throw new Error(j.error || r.statusText)
    const tps = j.eval_count && j.eval_duration ? (j.eval_count / (j.eval_duration / 1e9)).toFixed(0) : '?'
    ok(`L’IA répond (${m.name})`, `« ${(j.message?.content ?? '').trim().slice(0, 30)} » · ${((Date.now() - t) / 1000).toFixed(1).replace('.', ',')} s · ${tps} mots/s`)
  } catch (e) {
    fail(`Le modèle ${m.name} ne répond pas : ${e.message}`, 'Mémoire insuffisante ? Essayez un modèle plus petit depuis Lumen (Modèles locaux → Découvrir).')
  }
}

// 7. Lumen déjà lancé ? (4173 : version installée ; 5173 : développement)
let running = null
for (const url of ['http://127.0.0.1:4173', 'http://127.0.0.1:5173']) {
  try {
    if ((await (await get(url, { timeout: 1500 })).text()).includes('Lumen')) {
      running = url
      break
    }
  } catch {
    /* pas sur ce port */
  }
}
if (running) ok('Lumen tourne', running)
else if (!quiet) console.log(`  ${c(2, '·')} Lumen n’est pas lancé ${c(2, '— « lumen » pour le démarrer')}`)

console.log(failed ? `\n${c(31, `${failed} problème(s) à corriger.`)}\n` : `\n${c(32, 'Tout est prêt.')}\n`)
process.exit(failed ? 1 : 0)
