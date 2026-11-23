// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Profil matériel et conseils de modèles adaptés à la machine (logique réutilisable par l'installateur).
import { useEffect, useState } from 'react'
import { agentInfo, resetAgentInfo } from './agent'
import type { Tone } from './models'

export type Gpu = { kind: 'apple' | 'nvidia' | 'amd' | 'intel' | 'none'; name: string; vramGB?: number; cores?: number; unified?: boolean }
export type SystemInfo = { platform: string; arch: string; cpu: string; cores: number; ramGB: number; gpu: Gpu; diskFreeGB: number | null }
export type Fit = 'fluide' | 'possible' | 'lourd'

const nf = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })

/**
 * Mémoire disponible pour les poids d'un modèle :
 *  - fast : le modèle tient entièrement sur le GPU / en mémoire unifiée → fluide ;
 *  - max  : il tourne encore, mais en partie sur le processeur ou avec une mémoire très juste → plus lent.
 */
export function budget(hw: SystemInfo): { fast: number; max: number; mode: 'unified' | 'gpu' | 'cpu' } {
  const ram = hw.ramGB
  if (hw.gpu.kind === 'apple') return { fast: ram * 0.65 - 1, max: ram * 0.8 - 1, mode: 'unified' }
  if ((hw.gpu.kind === 'nvidia' || hw.gpu.kind === 'amd') && (hw.gpu.vramGB ?? 0) >= 4)
    return { fast: hw.gpu.vramGB! - 0.8, max: hw.gpu.vramGB! + ram * 0.45, mode: 'gpu' }
  // Processeur seul : ~40 % de la RAM (le système et le navigateur gardent le reste ; contexte réduit sur petites machines)
  return { fast: Math.min(ram * 0.4, 6.5), max: ram * 0.6, mode: 'cpu' }
}

/** Mémoire réellement utilisée ≈ taille du fichier + cache de contexte (~10 % à 8k tokens) + marge. */
const OVERHEAD = 1.1
const MARGIN = 0.3
const needOf = (sizeGB: number) => sizeGB * OVERHEAD + MARGIN

export function fitOf(sizeGB: number, hw: SystemInfo): Fit {
  const b = budget(hw)
  const need = needOf(sizeGB)
  return need <= b.fast ? 'fluide' : need <= b.max ? 'possible' : 'lourd'
}

export const FIT_INFO: Record<Fit, { label: string; tone: Tone }> = {
  fluide: { label: 'Fluide', tone: 'success' },
  possible: { label: 'Possible', tone: 'accent' },
  lourd: { label: 'Trop lourd', tone: 'danger' },
}

export function fitHint(fit: Fit, hw: SystemInfo): string {
  const mode = budget(hw).mode
  if (fit === 'fluide') return mode === 'cpu' ? 'Tourne bien sur le processeur.' : 'Tient entièrement en mémoire vidéo : réponses rapides.'
  if (fit === 'possible')
    return mode === 'gpu'
      ? 'Dépasse la mémoire vidéo : une partie tourne sur le processeur, plus lent.'
      : mode === 'unified'
        ? 'Mémoire juste : fonctionne, mais peut ralentir le reste de la machine.'
        : 'Sur le processeur : fonctionne, mais lentement.'
  return 'Trop gros pour cette machine : risque de blocage ou de lenteur extrême.'
}

/** Plus gros modèle « fluide », en Go de fichier, et équivalent approximatif en paramètres (Q4 ≈ 0,6 Go par milliard). */
export function fluidLimit(hw: SystemInfo): { sizeGB: number; paramsB: number } {
  const sizeGB = Math.max(0, (budget(hw).fast - MARGIN) / OVERHEAD)
  return { sizeGB, paramsB: sizeGB / 0.6 }
}

export function describeMachine(hw: SystemInfo): string {
  const parts = [hw.gpu.kind === 'apple' ? hw.gpu.name : hw.cpu]
  parts.push(hw.gpu.unified ? `${nf(hw.ramGB)} Go de mémoire unifiée` : `${nf(hw.ramGB)} Go de RAM`)
  if (hw.gpu.kind === 'apple' && hw.gpu.cores) parts.push(`GPU ${hw.gpu.cores} cœurs`)
  else if (hw.gpu.kind !== 'none') parts.push(`${hw.gpu.name}${hw.gpu.vramGB ? ` (${nf(hw.gpu.vramGB)} Go)` : ''}`)
  else parts.push('pas de carte graphique dédiée')
  return parts.join(' · ')
}

// ---------- Catalogue (bibliothèque Ollama, tailles réelles du registre en Q4) ----------
export type Category = 'general' | 'office' | 'code' | 'reasoning' | 'vision' | 'image'
export const CATEGORY_LABEL: Record<Category, string> = {
  general: 'Généraliste',
  office: 'Bureautique',
  code: 'Code',
  reasoning: 'Raisonnement',
  vision: 'Vision',
  image: 'Images',
}
/** Ce que la catégorie apporte, en une ligne (affiché quand le modèle est conseillé pour un usage secondaire). */
export const CATEGORY_HINT: Record<Category, string> = {
  general: 'Discussion, questions, idées',
  office: 'Mails, rédaction, résumés, traduction',
  code: 'Programmes, sites, scripts, débogage',
  reasoning: 'Maths, logique, problèmes pas à pas',
  vision: 'Lit les images, captures et documents scannés',
  image: 'Dessine logos, icônes et illustrations (SVG)',
}

/** standard = version officielle (avec garde-fous) ; uncensored = version modifiée (« abliterated », Dolphin) qui refuse beaucoup moins. */
export type Variant = 'standard' | 'uncensored'
export const VARIANT_LABEL: Record<Variant, string> = { standard: 'Standard', uncensored: 'Non censuré' }

/** `alsoFor` : catégories secondaires où le modèle peut aussi être conseillé (ex. un petit modèle à réflexion). */
export type CatalogModel = {
  name: string
  desc: string
  sizeGB: number
  category: Category
  alsoFor?: Category[]
  variant?: Variant // standard par défaut
  tags: { label: string; tone: Tone }[]
}
export const variantOf = (m: CatalogModel): Variant => m.variant ?? 'standard'

const V = { label: 'Vision', tone: 'violet' as Tone }
const R = { label: 'Réflexion', tone: 'info' as Tone }
const C = { label: 'Code', tone: 'accent' as Tone }
const O = { label: 'Outils', tone: 'neutral' as Tone }
const U = { label: 'Non censuré', tone: 'danger' as Tone }

const STANDARD: CatalogModel[] = [
  // Généralistes
  { name: 'gemma3:270m', desc: 'Ultra-léger : réponses simples, tourne partout', sizeGB: 0.3, category: 'general', tags: [] },
  { name: 'qwen3:0.6b', desc: 'Minuscule, avec réflexion (petites machines)', sizeGB: 0.5, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  { name: 'gemma3:1b', desc: 'Généraliste très léger de Google, bon en français', sizeGB: 0.8, category: 'general', alsoFor: ['office'], tags: [] },
  { name: 'qwen3:1.7b', desc: 'Généraliste léger, avec réflexion', sizeGB: 1.4, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  { name: 'qwen3:4b', desc: 'Généraliste léger, réflexion activable', sizeGB: 2.5, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  { name: 'qwen3:8b', desc: 'Généraliste équilibré', sizeGB: 5.2, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  { name: 'gemma4:e4b', desc: 'Nouvelle génération Google : texte, images, multilingue', sizeGB: 6.6, category: 'general', alsoFor: ['office', 'vision'], tags: [V] },
  { name: 'gemma4:12b', desc: 'Google, multimodal et très bon rédacteur', sizeGB: 8, category: 'general', alsoFor: ['office', 'vision'], tags: [V] },
  { name: 'gemma3:12b', desc: 'Généraliste multimodal de Google', sizeGB: 8.2, category: 'general', alsoFor: ['office', 'vision'], tags: [V] },
  { name: 'qwen3:14b', desc: 'Généraliste solide', sizeGB: 9.3, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  { name: 'gemma3:27b', desc: 'Grand multimodal de Google', sizeGB: 17.4, category: 'general', alsoFor: ['office', 'vision'], tags: [V] },
  { name: 'qwen3:30b', desc: 'Généraliste rapide (MoE) et très capable', sizeGB: 18.6, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  // Bureautique : mails, rédaction, résumés, traduction
  { name: 'llama3.2:1b', desc: 'Résumés et mails courts, très léger (Meta)', sizeGB: 1.3, category: 'office', alsoFor: ['general'], tags: [O] },
  { name: 'llama3.2:3b', desc: 'Rédaction, résumés et reformulation, léger', sizeGB: 2, category: 'office', alsoFor: ['general'], tags: [O] },
  { name: 'mistral:7b', desc: 'Mails et rédaction en français (Mistral AI)', sizeGB: 4.4, category: 'office', alsoFor: ['general'], tags: [O] },
  { name: 'mistral-nemo:12b', desc: 'Longs documents, résumés, traduction (contexte 128k)', sizeGB: 7.1, category: 'office', alsoFor: ['general'], tags: [O] },
  { name: 'mistral-small3.2:24b', desc: 'Le plus complet : documents longs, images, outils', sizeGB: 15.2, category: 'office', alsoFor: ['general', 'vision'], tags: [V, O] },
  // Code (dessinent aussi très bien en SVG)
  { name: 'qwen2.5-coder:0.5b', desc: 'Code, ultra-léger (petites machines)', sizeGB: 0.4, category: 'code', alsoFor: ['image'], tags: [C] },
  { name: 'qwen2.5-coder:1.5b', desc: 'Code, très léger', sizeGB: 1, category: 'code', alsoFor: ['image'], tags: [C] },
  { name: 'qwen2.5-coder:3b', desc: 'Code, léger', sizeGB: 1.9, category: 'code', alsoFor: ['image'], tags: [C] },
  { name: 'qwen2.5-coder:7b', desc: 'Code, rapide et polyvalent', sizeGB: 4.7, category: 'code', alsoFor: ['image'], tags: [C, O] },
  { name: 'qwen2.5-coder:14b', desc: 'Code, plus précis', sizeGB: 9, category: 'code', alsoFor: ['image'], tags: [C, O] },
  { name: 'qwen3-coder:30b', desc: 'Code et agent, rapide (MoE)', sizeGB: 18.6, category: 'code', alsoFor: ['image'], tags: [C, O] },
  { name: 'qwen2.5-coder:32b', desc: 'Code, le plus fort de la famille', sizeGB: 19.9, category: 'code', alsoFor: ['image'], tags: [C, O] },
  // Raisonnement
  { name: 'deepseek-r1:1.5b', desc: 'Raisonnement minuscule, pour petites machines', sizeGB: 1.1, category: 'reasoning', tags: [R] },
  { name: 'deepseek-r1:7b', desc: 'Raisonne pas à pas, léger', sizeGB: 4.7, category: 'reasoning', tags: [R] },
  { name: 'deepseek-r1:14b', desc: 'Raisonne pas à pas', sizeGB: 9, category: 'reasoning', tags: [R] },
  { name: 'gpt-oss:20b', desc: 'Raisonnement et outils (OpenAI, ouvert)', sizeGB: 13.8, category: 'reasoning', tags: [R, O] },
  { name: 'deepseek-r1:32b', desc: 'Raisonnement poussé', sizeGB: 19.9, category: 'reasoning', tags: [R] },
  // Vision : lire des images
  { name: 'moondream', desc: 'Vision minuscule, décrit les images', sizeGB: 1.7, category: 'vision', tags: [V] },
  { name: 'qwen3-vl:2b', desc: 'Lit les captures et le texte des images, très léger', sizeGB: 1.9, category: 'vision', tags: [V] },
  { name: 'gemma3:4b', desc: 'Petit multimodal de Google', sizeGB: 3.4, category: 'vision', alsoFor: ['general', 'office'], tags: [V] },
  { name: 'qwen3-vl:4b', desc: 'Lit captures, schémas et documents', sizeGB: 3.3, category: 'vision', tags: [V] },
  { name: 'qwen3-vl:8b', desc: 'Vision précise : documents, graphiques, interfaces', sizeGB: 6.2, category: 'vision', tags: [V, O] },
]

const H = 'huihui_ai/'
const UNCENSORED: CatalogModel[] = [
  // Généralistes
  { name: `${H}qwen3-abliterated:0.6b`, desc: 'Qwen3 sans refus, minuscule', sizeGB: 0.4, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R] },
  { name: `${H}gemma3-abliterated:1b`, desc: 'Gemma 3 sans refus, très léger', sizeGB: 0.8, category: 'general', alsoFor: ['office'], tags: [] },
  { name: `${H}qwen3-abliterated:1.7b`, desc: 'Qwen3 sans refus, léger, avec réflexion', sizeGB: 1.1, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R] },
  { name: `${H}qwen3-abliterated:4b`, desc: 'Qwen3 sans refus, réflexion activable', sizeGB: 2.5, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R] },
  { name: 'dolphin3:8b', desc: 'Dolphin 3 : assistant sans filtre qui suit vos consignes', sizeGB: 4.9, category: 'general', alsoFor: ['office'], tags: [O] },
  { name: `${H}qwen3-abliterated:8b`, desc: 'Qwen3 sans refus, équilibré', sizeGB: 5, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  { name: `${H}qwen3-abliterated:14b`, desc: 'Qwen3 sans refus, solide', sizeGB: 9, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  { name: `${H}qwen3-abliterated:30b`, desc: 'Qwen3 sans refus, rapide (MoE) et très capable', sizeGB: 18.6, category: 'general', alsoFor: ['reasoning', 'image'], tags: [R, O] },
  // Bureautique
  { name: `${H}llama3.2-abliterate:1b`, desc: 'Llama 3.2 sans refus : textes courts, très léger', sizeGB: 1, category: 'office', alsoFor: ['general'], tags: [] },
  { name: `${H}llama3.2-abliterate:3b`, desc: 'Llama 3.2 sans refus : rédaction, résumés', sizeGB: 2.2, category: 'office', alsoFor: ['general'], tags: [O] },
  { name: 'dolphin-mistral:7b', desc: 'Dolphin (Mistral) : rédaction libre en français', sizeGB: 4.1, category: 'office', alsoFor: ['general'], tags: [] },
  { name: `${H}mistral-small-abliterated:24b`, desc: 'Mistral Small sans refus : documents longs, outils', sizeGB: 14.3, category: 'office', alsoFor: ['general'], tags: [O] },
  // Code
  { name: `${H}qwen2.5-coder-abliterate:0.5b`, desc: 'Code sans refus, ultra-léger', sizeGB: 0.4, category: 'code', alsoFor: ['image'], tags: [C] },
  { name: `${H}qwen2.5-coder-abliterate:1.5b`, desc: 'Code sans refus, très léger', sizeGB: 1.1, category: 'code', alsoFor: ['image'], tags: [C] },
  { name: `${H}qwen2.5-coder-abliterate:3b`, desc: 'Code sans refus, léger', sizeGB: 1.9, category: 'code', alsoFor: ['image'], tags: [C] },
  { name: `${H}qwen2.5-coder-abliterate:7b`, desc: 'Code sans refus, rapide', sizeGB: 4.7, category: 'code', alsoFor: ['image'], tags: [C, O] },
  { name: `${H}qwen2.5-coder-abliterate:14b`, desc: 'Code sans refus, précis', sizeGB: 9, category: 'code', alsoFor: ['image'], tags: [C, O] },
  { name: `${H}qwen3-coder-abliterated:30b`, desc: 'Code et agent sans refus (MoE)', sizeGB: 18.6, category: 'code', alsoFor: ['image'], tags: [C, O] },
  // Raisonnement
  { name: `${H}deepseek-r1-abliterated:1.5b`, desc: 'Raisonnement sans refus, minuscule', sizeGB: 1.1, category: 'reasoning', tags: [R] },
  { name: `${H}deepseek-r1-abliterated:7b`, desc: 'Raisonnement sans refus, léger', sizeGB: 4.7, category: 'reasoning', tags: [R] },
  { name: `${H}deepseek-r1-abliterated:14b`, desc: 'Raisonnement sans refus', sizeGB: 9, category: 'reasoning', tags: [R] },
  { name: `${H}gpt-oss-abliterated:20b`, desc: 'gpt-oss sans refus : raisonnement et outils', sizeGB: 13.8, category: 'reasoning', tags: [R, O] },
  { name: `${H}deepseek-r1-abliterated:32b`, desc: 'Raisonnement poussé sans refus', sizeGB: 19.9, category: 'reasoning', tags: [R] },
  // Vision
  { name: `${H}qwen3-vl-abliterated:2b`, desc: 'Vision sans refus, très légère', sizeGB: 1.9, category: 'vision', tags: [V] },
  { name: `${H}qwen3-vl-abliterated:4b`, desc: 'Vision sans refus : captures, documents', sizeGB: 3.3, category: 'vision', tags: [V] },
  { name: `${H}qwen3-vl-abliterated:8b`, desc: 'Vision sans refus, précise', sizeGB: 6.1, category: 'vision', tags: [V] },
]

export const CATALOG: CatalogModel[] = [
  ...STANDARD,
  ...UNCENSORED.map((m) => ({ ...m, variant: 'uncensored' as const, tags: [U, ...m.tags] })),
]

const FIT_RANK: Record<Fit, number> = { fluide: 0, possible: 1, lourd: 2 }

export type Reco = { category: Category; model: CatalogModel; fit: Fit; primary: boolean }

/**
 * Pour chaque usage, le plus capable des modèles qui restent fluides (sinon « possibles », sinon le plus léger),
 * sans proposer deux fois le même modèle : même une machine de 4 Go reçoit ainsi plusieurs modèles différents.
 * `variant` : la version demandée passe avant les autres tant qu'elle tourne sur la machine ; sinon (aucune version
 * non censurée qui tienne, par exemple), la version standard prend le relais.
 * Les usages sont remplis par priorité puis affichés dans l'ordre habituel.
 */
export function recommend(hw: SystemInfo, variant: Variant = 'standard'): Reco[] {
  const used = new Set<string>()
  const picks = new Map<Category, Reco>()
  for (const category of ['general', 'code', 'office', 'reasoning', 'vision', 'image'] as Category[]) {
    const options = CATALOG.filter((m) => !used.has(m.name) && (m.category === category || m.alsoFor?.includes(category)))
      .map((m) => ({ model: m, fit: fitOf(m.sizeGB, hw), primary: m.category === category, other: variantOf(m) !== variant }))
      .sort(
        (a, b) =>
          Number(a.fit === 'lourd') - Number(b.fit === 'lourd') ||
          Number(a.other) - Number(b.other) ||
          FIT_RANK[a.fit] - FIT_RANK[b.fit] ||
          // fluide : le plus gros (le plus capable) ; sinon le plus léger (le plus susceptible de tourner)
          (a.fit === 'fluide' ? Number(b.primary) - Number(a.primary) || b.model.sizeGB - a.model.sizeGB : a.model.sizeGB - b.model.sizeGB),
      )
    const best = options[0]
    if (!best) continue
    used.add(best.model.name)
    picks.set(category, { category, model: best.model, fit: best.fit, primary: best.primary })
  }
  return (Object.keys(CATEGORY_LABEL) as Category[]).filter((c) => picks.has(c)).map((c) => picks.get(c)!)
}

/** Petites machines : contexte par défaut réduit pour limiter la mémoire utilisée par chaque modèle. */
export const isLowMemory = (hw: SystemInfo) => hw.ramGB <= 6.5

// ---------- Récupération (une fois par session) ----------
let cache: Promise<SystemInfo> | null = null

export function fetchHardware(): Promise<SystemInfo> {
  cache ??= agentInfo()
    .then((i) => fetch('/agent/system', { headers: { 'x-lumen-token': i.token }, cache: 'no-store' }))
    .then((r) => {
      if (!r.ok) throw new Error(`Profil matériel indisponible (${r.status})`)
      return r.json() as Promise<SystemInfo>
    })
    .catch((e) => {
      cache = null
      throw e
    })
  return cache
}

export function useHardware(): SystemInfo | null {
  const [hw, setHw] = useState<SystemInfo | null>(null)
  useEffect(() => {
    let alive = true
    fetchHardware().then(
      (h) => alive && setHw(h),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [])
  return hw
}

export const GiB = (bytes: number) => bytes / 2 ** 30

// ---------- Utilisation en direct (mémoire, processeur, GPU) ----------
export type Usage = {
  ramTotalGB: number
  ramUsedGB: number
  cpuPct: number
  gpuPct: number | null // Mac (Apple Silicon) et NVIDIA
  gpuMemUsedGB: number | null
  gpuMemTotalGB: number | null // carte NVIDIA seulement (mémoire unifiée sur Mac)
}

export async function fetchUsage(): Promise<Usage> {
  const i = await agentInfo()
  const r = await fetch('/agent/usage', { headers: { 'x-lumen-token': i.token }, cache: 'no-store' })
  if (r.status === 401) resetAgentInfo() // serveur redémarré : nouveau jeton à la prochaine mesure
  if (!r.ok) throw new Error(`Mesure indisponible (${r.status})`)
  return (await r.json()) as Usage
}

/** Mesure en direct toutes les `ms` millisecondes, seulement quand la page est visible. */
export function useLiveUsage(ms = 2000): Usage | null {
  const [u, setU] = useState<Usage | null>(null)
  useEffect(() => {
    let alive = true
    const tick = () => {
      if (!document.hidden) fetchUsage().then((x) => alive && setU(x), () => {})
    }
    tick()
    const id = setInterval(tick, ms)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [ms])
  return u
}
