// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import type { ModelInfo } from './ollama'

export type Tone = 'neutral' | 'accent' | 'success' | 'info' | 'violet' | 'danger'

/** « hf.co/user/Qwen3-27B-GGUF:Q4_K_M » → « Qwen3-27B » */
export function prettyName(name: string): string {
  const withoutHost = name.replace(/^hf\.co\//, '')
  const parts = withoutHost.split('/')
  const last = parts[parts.length - 1]
  const [base, tag] = last.split(':')
  const cleanBase = base.replace(/[-_.]i1[-_.]GGUF$/i, '').replace(/[-_.]GGUF$/i, '')
  if (!tag || tag === 'latest' || /^(i?q\d|f16|f32|bf16)/i.test(tag)) return cleanBase
  return `${cleanBase}:${tag}`
}

export const hasCap = (m: ModelInfo | undefined, cap: string) => !!m?.capabilities?.includes(cap)

/** Si Ollama ne renvoie pas les capacités (anciennes versions), on suppose le cas le plus permissif. */
export const supportsVision = (m: ModelInfo | undefined) => !m?.capabilities || m.capabilities.includes('vision')
export const supportsThinking = (m: ModelInfo | undefined) => hasCap(m, 'thinking')
export const supportsTools = (m: ModelInfo | undefined) => !m?.capabilities || m.capabilities.includes('tools')

export const isChatModel = (m: ModelInfo) => {
  if (m.capabilities?.length) return m.capabilities.includes('completion')
  return !/embed/i.test(m.name)
}

const TONES: Tone[] = ['violet', 'info', 'accent', 'success', 'danger']
export function toneFor(name: string): Tone {
  const key = prettyName(name).toLowerCase().replace(/[^a-z]/g, '').slice(0, 6)
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return TONES[h % TONES.length]
}

export const letterFor = (name: string) =>
  (prettyName(name).replace(/[^A-Za-z0-9]/g, '')[0] ?? '?').toUpperCase()

export const formatCtx = (n?: number) => (!n ? '—' : n >= 1024 ? `${Math.round(n / 1024)}k` : String(n))

export function capabilityTags(m: ModelInfo): { label: string; tone: Tone }[] {
  const caps = m.capabilities ?? []
  const out: { label: string; tone: Tone }[] = []
  if (caps.includes('vision')) out.push({ label: 'Vision', tone: 'violet' })
  if (caps.includes('thinking')) out.push({ label: 'Réflexion', tone: 'info' })
  if (caps.includes('tools')) out.push({ label: 'Outils', tone: 'neutral' })
  if (caps.includes('insert') || /coder|code/i.test(m.name)) out.push({ label: 'Code', tone: 'accent' })
  if (caps.includes('embedding')) out.push({ label: 'Embeddings', tone: 'neutral' })
  return out
}

export function modelSubtitle(m: ModelInfo): string {
  const d = m.details ?? {}
  return [d.family, d.parameter_size, d.context_length ? `${formatCtx(d.context_length)} ctx` : null]
    .filter(Boolean)
    .join(' · ')
}

/** Sélection de modèles populaires de la bibliothèque Ollama (tailles approximatives). */
export const DISCOVER: { name: string; desc: string; size: string; tags: { label: string; tone: Tone }[] }[] = [
  { name: 'qwen2.5-coder:7b', desc: 'Spécialiste du code, rapide', size: '≈ 4,7 Go', tags: [{ label: 'Code', tone: 'accent' }, { label: 'Outils', tone: 'neutral' }] },
  { name: 'qwen2.5vl:7b', desc: 'Lit les captures, schémas et documents', size: '≈ 6 Go', tags: [{ label: 'Vision', tone: 'violet' }] },
  { name: 'gemma3:12b', desc: 'Généraliste multimodal de Google', size: '≈ 8,1 Go', tags: [{ label: 'Vision', tone: 'violet' }] },
  { name: 'deepseek-r1:14b', desc: 'Raisonne pas à pas avant de répondre', size: '≈ 9 Go', tags: [{ label: 'Réflexion', tone: 'info' }] },
  { name: 'qwen3:8b', desc: 'Polyvalent, réflexion activable', size: '≈ 5,2 Go', tags: [{ label: 'Réflexion', tone: 'info' }, { label: 'Outils', tone: 'neutral' }] },
  { name: 'llama3.2-vision:11b', desc: 'Vision par Meta', size: '≈ 7,8 Go', tags: [{ label: 'Vision', tone: 'violet' }] },
  { name: 'mistral-small3.1:24b', desc: 'Contexte 128k, vision et outils', size: '≈ 15 Go', tags: [{ label: 'Vision', tone: 'violet' }, { label: 'Outils', tone: 'neutral' }] },
  { name: 'gpt-oss:20b', desc: 'Modèle ouvert d’OpenAI, raisonnement', size: '≈ 14 Go', tags: [{ label: 'Réflexion', tone: 'info' }, { label: 'Outils', tone: 'neutral' }] },
]
