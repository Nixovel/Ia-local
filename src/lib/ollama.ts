// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Client minimal pour l'API REST d'Ollama (https://github.com/ollama/ollama/blob/main/docs/api.md)

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
}

export type ChatRequest = {
  model: string
  messages: ApiMessage[]
  options?: ChatOptions
  think?: boolean
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

  /** Charge le modèle en mémoire sans rien générer. */
  load: (model: string, keep_alive: string | number = '30m') =>
    json('/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive }) }),

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
    const res = await request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ ...req, stream: true }),
      signal,
    })
    for await (const c of ndjson<ChatChunk>(res)) {
      if (c.error) throw new OllamaError(c.error)
      onChunk(c)
    }
  },
}

/**
 * Tokens proposés à chaque pas par la tête MTP (« multi-token prediction ») d'un modèle qui en a une.
 * Mesuré sur Qwen3.8 27B (Mac M5, 32 Go) : génération ×1,8 à ×2 sur du texte, ×3 sur du code.
 * 4 est le meilleur réglage mesuré (de 2 à 6 essayés).
 */
export const MTP_DRAFT_TOKENS = 4

const mtpHeads = new Map<string, Promise<boolean>>()

/** Vrai si le modèle contient une tête MTP (clé GGUF `<architecture>.nextn_predict_layers` > 0). Lu une fois par modèle. */
export function hasMtpHead(model: string): Promise<boolean> {
  const key = `${baseUrl}|${model}`
  let found = mtpHeads.get(key)
  if (!found) {
    found = json<{ model_info?: Record<string, unknown> }>('/api/show', { method: 'POST', body: JSON.stringify({ model }) })
      .then((r) => Object.entries(r.model_info ?? {}).some(([k, v]) => k.endsWith('.nextn_predict_layers') && Number(v) > 0))
      .catch(() => {
        mtpHeads.delete(key) // Ollama injoignable : on réessaiera à la prochaine requête
        return false
      })
    mtpHeads.set(key, found)
  }
  return found
}

/**
 * Options de décodage spéculatif à ajouter à **toutes** les requêtes vers ce modèle (réponse et résumé) :
 * si deux requêtes n'ont pas les mêmes options, Ollama recharge le modèle entre les deux.
 */
export async function draftOptions(model: string): Promise<Pick<ChatOptions, 'draft_num_predict'>> {
  return (await hasMtpHead(model)) ? { draft_num_predict: MTP_DRAFT_TOKENS } : {}
}
