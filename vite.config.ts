// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import { agentBridge } from './agent/bridge'
import { voiceAssets } from './agent/voice-assets'

// Adresse du serveur Ollama local (modifiable : OLLAMA_URL=http://192.168.1.20:11434 npm run dev)
const BANNER = '/*! Lumen — © 2026 Nixovel — https://github.com/Nixovel/Ia-local — Tous droits réservés (voir LICENSE). */'

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'

const proxy: Record<string, ProxyOptions> = {
  '/ollama': {
    target: OLLAMA_URL,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/ollama/, ''),
    // Si le navigateur coupe la requête (bouton « Arrêter », rechargement de page), on coupe aussi
    // la connexion vers Ollama : sinon il continue de générer pour personne et bloque la file d'attente.
    configure: (server) => {
      server.on('proxyReq', (proxyReq, _req, res) => {
        res.on('close', () => {
          if (!res.writableEnded) proxyReq.destroy()
        })
      })
    },
  },
}

// Isolation cross-origin : autorise le calcul multi-cœur (SharedArrayBuffer) de la voix et de la reconnaissance vocale.
// « credentialless » laisse charger les ressources d'autres sites (CDN des aperçus, Hugging Face) sans cookies.
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' }

export default defineConfig({
  // agentBridge : exécute les outils de l'agent (commandes, fichiers, apps) pour l'interface, en local uniquement.
  // voiceAssets : fichiers des moteurs vocaux (onnxruntime, détection de parole, phonémiseur) servis en local.
  plugins: [react(), agentBridge(), voiceAssets()],
  server: { port: 5173, host: '127.0.0.1', proxy, headers },
  preview: { port: 4173, host: '127.0.0.1', proxy, headers },
  worker: { format: 'es', rolldownOptions: { output: { postBanner: BANNER } } },
  // Mention d'auteur conservée dans le JavaScript compilé (commentaire légal /*! … */)
  build: { rolldownOptions: { output: { postBanner: BANNER } } },
})
