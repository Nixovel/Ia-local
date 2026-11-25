// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Client minimal pour l'API REST d'Ollama (https://github.com/ollama/ollama/blob/main/docs/api.md)
import { agentInfo } from './agent'

export type ModelDetails = {
  family?: string
  families?: string[]
  parameter_size?: string
  quantization_level?: string
  context_length?: number
  format?: string
}

export type ModelInfo = {
  name: string
  model: string
  size: number
  digest: string
  modified_at: string
  details: ModelDetails
  capabilities?: string[]
}

export type RunningModel = {
  name: string
  model: string
  size: number
  size_vram: number
  expires_at: string
  context_length?: number
  details?: ModelDetails
}

export type ApiToolCall = {
  id?: string
  function: { index?: number; name: string; arguments: Record<string, unknown> }
}

export type OllamaTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: { type: 'object'; properties: Record<string, { type: string; description: string; enum?: string[] }>; required: string[] }
  }
}

export type ApiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  thinking?: string
  tool_calls?: ApiToolCall[]
  tool_name?: string
  tool_call_id?: string
}

export type ChatOptions = {
  temperature?: number
  top_p?: number
  repeat_penalty?: number
  num_ctx?: number
  /** Décodage spéculatif MTP d'Ollama : tokens proposés par la tête intégrée au modèle, puis vérifiés par lui. */
  draft_num_predict?: number
  /** Taille des lots de lecture du prompt (llama.cpp -b / -ub). */
  num_batch?: number
  /** Nombre maximal de tokens générés. */
  num_predict?: number
}

export type ChatRequest = {
  model: string
  messages: ApiMessage[]
  options?: ChatOptions
  /** true / false, ou un niveau pour les modèles qui en ont (Qwen3.8 : low, medium, true = xhigh). */
  think?: boolean | 'low' | 'medium' | 'high'
  keep_alive?: string | number
  tools?: OllamaTool[]
}

export type ChatChunk = {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: ApiToolCall[] }
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number
  error?: string
}

export type PullProgress = {
  status: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

let baseUrl = '/ollama'
export const setBaseUrl = (url: string) => {
  baseUrl = url.replace(/\/+$/, '') || '/ollama'
  appleSilicon = null // autre serveur : autre machine peut-être
}
export const getBaseUrl = () => baseUrl

export class OllamaError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(baseUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new OllamaError(`Impossible de joindre Ollama (${baseUrl}). Vérifiez qu'il tourne : « ollama serve ».`)
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* corps non JSON */
    }
    throw new OllamaError(msg, res.status)
  }
  return res
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init)
  return res.json() as Promise<T>
}

/** Lit un flux NDJSON (une ligne JSON par événement). */
async function* ndjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) yield JSON.parse(line) as T
    }
  }
  const rest = buffer.trim()
  if (rest) yield JSON.parse(rest) as T
}

export const ollama = {
  version: () => json<{ version: string }>('/api/version'),
  tags: () => json<{ models: ModelInfo[] }>('/api/tags').then((r) => r.models ?? []),
  ps: () => json<{ models: RunningModel[] }>('/api/ps').then((r) => r.models ?? []),

  /**
   * Charge le modèle en mémoire sans rien générer, avec les réglages qu'utiliseront les réponses :
   * sinon Ollama le chargerait une première fois ici (contexte par défaut, sans MTP), puis de nouveau au premier message.
   */
  load: async (model: string, keep_alive: string | number = KEEP_ALIVE) => {
    const t = await traitsOf(model)
    const options = { ...(await loadOptionsOf(t)), num_ctx: await stableCtx(model, STABLE_CTX, t) }
    return json('/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive, options }) })
  },

  /** Décharge immédiatement le modèle de la VRAM. */
  unload: (model: string) =>
    json('/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }),

  remove: (model: string) =>
    request('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }) }).then(() => undefined),

  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal) {
    const res = await request('/api/pull', {
      method: 'POST',
      body: JSON.stringify({ model, stream: true }),
      signal,
    })
    for await (const p of ndjson<PullProgress>(res)) {
      if (p.error) throw new OllamaError(p.error)
      onProgress(p)
    }
  },

  async chat(req: ChatRequest, onChunk: (c: ChatChunk) => void, signal?: AbortSignal) {
    // Un préchauffage en cours passerait avant (une requête à la fois) : on l'arrête, ce qu'il a déjà lu reste acquis
    warming?.abort()
    const res = await request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ ...(await tuned(req)), stream: true }),
      signal,
    })
    for await (const c of ndjson<ChatChunk>(res)) {
      if (c.error) throw new OllamaError(c.error)
      onChunk(c)
    }
  },

  /**
   * Fait lire à Ollama le début d'une requête (consignes, outils, historique) en ne générant qu'un token :
   * la vraie requête, si elle commence pareil, reprend là où la lecture s'est arrêtée. Un seul à la fois ;
   * `chat` l'interrompt. Renvoie false s'il a été interrompu ou a échoué.
   */
  async prewarm(req: ChatRequest): Promise<boolean> {
    warming?.abort()
    const ctl = new AbortController()
    warming = ctl
    try {
      const body = await tuned({ ...req, options: { ...req.options, num_predict: 1 } })
      if (ctl.signal.aborted) return false
      const res = await request('/api/chat', { method: 'POST', body: JSON.stringify({ ...body, stream: false }), signal: ctl.signal })
      await res.text()
      return true
    } catch {
      return false
    } finally {
      if (warming === ctl) warming = null
    }
  },
}

let warming: AbortController | null = null

/**
 * Tokens proposés à chaque pas par la tête MTP (« multi-token prediction ») d'un modèle qui en a une.
 * Mesuré sur Qwen3.8 27B (Mac M5, 32 Go) : génération ×1,8 à ×2 sur du texte, ×3 sur du code.
 * 4 est le meilleur réglage mesuré (de 2 à 6 essayés).
 */
export const MTP_DRAFT_TOKENS = 4

/**
 * Taille des lots de lecture du prompt sur Mac Apple Silicon (Ollama local), mesurée sur un M5 (32 Go, prompt de 5 600 tokens) :
 *  - modèles denses ou hybrides : 256. Qwen3.8 27B (hybride) 151 → 161 t/s, Qwen2.5 7B 543 → 592 ; 1024 et 2048 sont plus lents ;
 *  - modèles MoE (« experts ») : 1024. Gemma4 26B-A4B 748 → 806 t/s ; 256 est plus lent (668), 2048 n'apporte rien de plus.
 * Ailleurs (PC, carte graphique), on garde la valeur d'Ollama (512).
 */
const APPLE_BATCH = { dense: 256, moe: 1024 } as const

/** Contexte des modes Agent, Web et Labo (TOOLS_MIN_CTX de chat.ts) : Lumen le demande à tous les modèles. */
export const STABLE_CTX = 16384
/** En dessous, l'utilisateur a choisi un petit contexte (mode « mémoire faible ») : on le respecte. */
const SMALL_CTX = 8192

/**
 * Durée pendant laquelle Ollama garde le modèle chargé après une réponse (5 min par défaut chez Ollama).
 * Le déchargement fait perdre aussi le prompt déjà lu : au retour d'une pause, il fallait recharger (≈ 5 s)
 * puis relire consignes et outils (jusqu'à 35 s sur Qwen3.8 27B) avant le premier mot.
 */
export const KEEP_ALIVE = '30m'

/** Ce que Lumen lit une fois par modèle dans /api/show pour choisir ses réglages de vitesse. */
type Traits = {
  /** Tête MTP intégrée (clé GGUF `<architecture>.nextn_predict_layers` > 0). */
  mtp: boolean
  /** Mélange d'experts (clé GGUF `<architecture>.expert_count` > 0). */
  moe: boolean
  /** Contexte d'entraînement : on ne demande pas plus pour rien. */
  ctxTrain: number
  /**
   * Gabarit à niveaux de réflexion (Qwen3.8) : `think: true` y vaut « xhigh » et ajoute une consigne
   * **en tête** du prompt, avant les outils.
   */
  effortLevels: boolean
}

const NO_TRAITS: Traits = { mtp: false, moe: false, ctxTrain: 0, effortLevels: false }
const traits = new Map<string, Promise<Traits>>()

function traitsOf(model: string): Promise<Traits> {
  const key = `${baseUrl}|${model}`
  let found = traits.get(key)
  if (!found) {
    found = json<{ model_info?: Record<string, unknown>; template?: string }>('/api/show', { method: 'POST', body: JSON.stringify({ model }) })
      .then((r) => {
        const info = r.model_info ?? {}
        const arch = String(info['general.architecture'] ?? '')
        const template = r.template ?? ''
        const positive = (suffix: string) => Object.entries(info).some(([k, v]) => k.endsWith(suffix) && Number(v) > 0)
        return {
          mtp: positive('.nextn_predict_layers'),
          moe: positive('.expert_count'),
          ctxTrain: Number(info[`${arch}.context_length`]) || 0,
          effortLevels: template.includes('reasoning_effort') && template.includes('xhigh'),
        }
      })
      .catch(() => {
        traits.delete(key) // Ollama injoignable : on réessaiera à la prochaine requête
        return NO_TRAITS
      })
    traits.set(key, found)
  }
  return found
}

/** Vrai si le modèle contient une tête MTP. Lu une fois par modèle. */
export const hasMtpHead = (model: string): Promise<boolean> => traitsOf(model).then((t) => t.mtp)

/** Options qui décident de la façon dont Ollama charge le modèle : changer l'une d'elles le recharge. */
type LoadOptions = Pick<ChatOptions, 'draft_num_predict' | 'num_batch'>

let appleSilicon: Promise<boolean> | null = null

/**
 * Vrai si Ollama tourne sur ce Mac et que c'est un Apple Silicon (pont Lumen : darwin / arm64).
 * La première réponse est gardée : si elle variait d'une requête à l'autre, num_batch aussi, et Ollama rechargerait.
 */
function onAppleSilicon(): Promise<boolean> {
  const local = /^\/|^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(baseUrl)
  if (!local) return Promise.resolve(false)
  appleSilicon ??= agentInfo().then(
    (i) => i.platform === 'darwin' && (i.arch ?? 'arm64') === 'arm64',
    () => false,
  )
  return appleSilicon
}

async function loadOptionsOf(t: Traits): Promise<LoadOptions> {
  return {
    ...(t.mtp ? { draft_num_predict: MTP_DRAFT_TOKENS } : {}),
    ...((await onAppleSilicon()) ? { num_batch: t.moe ? APPLE_BATCH.moe : APPLE_BATCH.dense } : {}),
  }
}

/**
 * Options de chargement à ajouter à **toutes** les requêtes vers ce modèle (réponse et résumé) :
 * si deux requêtes n'ont pas les mêmes, Ollama recharge le modèle entre les deux. `ollama.chat` les ajoute déjà.
 */
export async function draftOptions(model: string): Promise<LoadOptions> {
  return loadOptionsOf(await traitsOf(model))
}

/**
 * Contexte réellement demandé à Ollama. Changer num_ctx recharge le modèle (≈ 5 s) et fait perdre le prompt déjà lu :
 * avant, « ça va ? » (8 192) puis « crée un fichier » (mode Agent, 16 384) rechargeaient le modèle à chaque bascule,
 * et la réponse Agent attendait 42 s au lieu de 0,3 s. On garde donc un seul contexte : jamais plus petit que celui
 * du modèle déjà chargé, et au moins celui des modes avec outils.
 */
async function stableCtx(model: string, wanted: number, t: Traits): Promise<number> {
  // Plancher : le contexte des modes avec outils, sauf si l'utilisateur a choisi un petit contexte
  const floor = wanted < SMALL_CTX ? wanted : Math.max(wanted, t.ctxTrain ? Math.min(STABLE_CTX, t.ctxTrain) : STABLE_CTX)
  const loaded = (await ollama.ps().catch((): RunningModel[] => [])).find((r) => r.name === model || r.model === model)
  // Déjà chargé avec au moins autant (par Lumen ou un autre outil) : on le garde tel quel, sans rechargement
  return loaded?.context_length && loaded.context_length >= floor ? loaded.context_length : floor
}

/**
 * Requête réglée pour la vitesse, sans changer ce que voit le modèle :
 *  - mêmes options de chargement et même contexte pour toutes les requêtes (pas de rechargement entre deux modes) ;
 *  - modèle gardé chargé {@link KEEP_ALIVE} ;
 *  - Qwen3.8 : réflexion « medium » au lieu de « xhigh ». La consigne xhigh, placée en tête du prompt, le rendait
 *    différent selon que la réponse réfléchit ou non : le passage de l'un à l'autre faisait relire consignes et outils
 *    (35 s en mode Agent). « medium » n'ajoute rien : avec ou sans réflexion, le début du prompt est identique.
 */
async function tuned(req: ChatRequest): Promise<ChatRequest> {
  const t = await traitsOf(req.model)
  const options: ChatOptions = { ...req.options, ...(await loadOptionsOf(t)) }
  options.num_ctx = await stableCtx(req.model, options.num_ctx ?? STABLE_CTX, t)
  return {
    ...req,
    options,
    keep_alive: req.keep_alive ?? KEEP_ALIVE,
    ...(req.think === true && t.effortLevels ? { think: 'medium' as const } : {}),
  }
}
