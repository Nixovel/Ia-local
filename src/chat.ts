// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { thinkModeOf, toast, useStore, type Attachment, type Conversation, type Message, type Stats, type ToolCall } from './store'
import { ollama, type ApiMessage, type ApiToolCall, type ModelInfo } from './lib/ollama'
import { formatCtx, isChatModel, prettyName, supportsThinking, supportsTools, supportsVision } from './lib/models'
import {
  agentInfo, agentSystemPrompt, callTool, CLIENT_TOOLS, LAB_TOOL_NAMES, LAB_TOOLS, labSystemPrompt, needsApproval, parseTextToolCalls, TOOL_NAMES, TOOLS, WEB_TOOL_NAMES, WEB_TOOLS, webSystemPrompt,
  type ToolResult,
} from './lib/agent'
import { weather, webFetch, webSearch } from './lib/web'
import { CATALOG, CATEGORY_HINT, CATEGORY_LABEL, describeMachine, FIT_INFO, fetchHardware, fitOf, fluidLimit, GiB, recommend, VARIANT_LABEL, variantOf, type Variant } from './lib/hardware'
import { startPull } from './lib/pull'
import { langFromFilename } from './lib/codeblocks'
import { formatTime, uid } from './lib/format'
import { captureScreen, isTextFile, normalizeImage, readAsDataUrl } from './lib/files'
import { detectTask } from './lib/strengths'
import { voiceActive } from './voice/state'
import { wantsAction, wantsLab, wantsWeb } from './lib/intent'

const controllers = new Map<string, AbortController>()
const runs = new Map<string, Promise<void>>()
const MAX_TEXT_BYTES = 512 * 1024

const REASONING =
  /(pourquoi|expliqu|analys|compar|calcul|démontr|prouv|résou|débog|debug|optimis|étape|raisonn|réfléch|planifi|architect|algorithm|stratég|corrige|refactor|why|explain|analy[sz]|prove|solve|step by step)/i

/** Mode « auto » : réfléchir seulement si la demande le justifie (pas pour « salut »). */
export function shouldThink(m?: Message): boolean {
  if (!m) return false
  const text = m.content.trim()
  if (m.attachments?.length) return true
  if (text.includes('```') || text.split('\n').length > 2) return true
  if (text.length >= 140) return true
  return REASONING.test(text)
}

/** Convertit des fichiers déposés / collés / choisis en pièces jointes. */
export async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const f of files) {
    try {
      if (f.type.startsWith('image/') && f.type !== 'image/svg+xml') {
        const img = await normalizeImage(await readAsDataUrl(f))
        out.push({ id: uid(), kind: 'image', name: f.name || `image-${formatTime(Date.now())}.png`, mime: img.mime, size: f.size, dataUrl: img.dataUrl, width: img.width, height: img.height })
      } else if (isTextFile(f) || f.type === 'image/svg+xml') {
        if (f.size > MAX_TEXT_BYTES) {
          toast(`« ${f.name} » dépasse 512 Ko`, 'danger')
          continue
        }
        out.push({ id: uid(), kind: 'file', name: f.name, mime: f.type || 'text/plain', size: f.size, text: await f.text() })
      } else {
        toast(`Type non pris en charge : ${f.name}`, 'danger')
      }
    } catch {
      toast(`Lecture impossible : ${f.name}`, 'danger')
    }
  }
  return out
}

export async function addFiles(files: File[]) {
  const atts = await filesToAttachments(files)
  if (atts.length) useStore.getState().addDraftAttachments(atts)
}

export async function addScreenCapture() {
  try {
    const img = await captureScreen()
    const name = `Capture ${formatTime(Date.now()).replace(':', 'h')}.png`
    const size = Math.round((img.dataUrl.length * 3) / 4)
    useStore.getState().addDraftAttachments([
      { id: uid(), kind: 'image', name, mime: img.mime, size, dataUrl: img.dataUrl, width: img.width, height: img.height },
    ])
    useStore.getState().focusComposer()
  } catch (e) {
    if ((e as Error).name !== 'NotAllowedError') toast("Capture d'écran impossible", 'danger')
  }
}

function makeTitle(text: string, atts: Attachment[]): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? ''
  if (line) return line.length > 52 ? line.slice(0, 50).trimEnd() + '…' : line
  if (atts.some((a) => a.kind === 'image')) return "Analyse d'image"
  if (atts[0]) return `Fichier ${atts[0].name}`
  return 'Nouvelle conversation'
}

/**
 * Jetons estimés d'un texte. Un chiffre ou un retour à la ligne coûte ~1 jeton (Qwen découpe les nombres chiffre par
 * chiffre), un symbole ~2/3, le reste ~1/3,5. Mesuré sur Ollama (2026-11-24) : sortie de `seq` 100 %, texte et code
 * 111–121 %, sortie de `ls -la` 85 % — alors que « 3 caractères par jeton » ne comptait que 33 % d'une sortie chiffrée.
 */
function tokensOf(s: string): number {
  let digits = 0
  let newlines = 0
  let symbols = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 48 && c <= 57) digits++
    else if (c === 10) newlines++
    else if (c < 128 && c !== 32 && !((c | 32) >= 97 && (c | 32) <= 122)) symbols++
  }
  return digits + newlines + symbols / 1.5 + (s.length - digits - newlines - symbols) / 3.5
}

/** Taille estimée de messages enregistrés (~800 jetons par image). */
function estimateTokens(msgs: Message[], summaryText?: string): number {
  let tokens = tokensOf(summaryText ?? '')
  for (const m of msgs) {
    tokens += tokensOf(m.content)
    for (const a of m.attachments ?? []) tokens += a.kind === 'file' ? tokensOf(a.text ?? '') : 800
    for (const t of m.toolCalls ?? []) tokens += tokensOf(t.output ?? '') + tokensOf(JSON.stringify(t.args))
  }
  return tokens
}

/** Mémoire minimale quand le modèle a des outils : consignes de l'agent et définitions des outils pèsent déjà ≈ 3 700 jetons. */
const TOOLS_MIN_CTX = 16384
/** Part de la mémoire gardée libre pour la réponse : un fichier écrit par un outil (lab_write_file…) passe tout entier dans l'appel. */
const ANSWER_RESERVE = 0.3

/** Mémoire (contexte) réellement utilisée : jamais moins de 16 K avec des outils, sauf sur les petites machines. */
function contextFor(numCtx: number, withTools: boolean, info: ModelInfo | undefined, lowMemory: boolean): number {
  if (!withTools || lowMemory) return numCtx
  return Math.max(numCtx, Math.min(TOOLS_MIN_CTX, info?.details?.context_length || TOOLS_MIN_CTX))
}

/** Taille estimée de la requête complète (consignes, définitions d'outils, historique), en jetons. */
function estimateRequest(history: ApiMessage[], tools: unknown[]): number {
  let tokens = tools.length ? tokensOf(JSON.stringify(tools)) : 0
  for (const m of history)
    tokens += tokensOf(m.content) + (m.tool_calls ? tokensOf(JSON.stringify(m.tool_calls)) : 0) + (m.images?.length ?? 0) * 800
  return tokens
}

/**
 * Mémoire du modèle pleine : Ollama refuse la requête (« exceeds the available context size »), ou la coupe pendant
 * que le modèle écrit un appel d'outil, qui arrive alors en JSON incomplet (« unexpected end of JSON input »).
 */
const isContextFull = (e: unknown) =>
  /invalid tool call arguments|unexpected end of JSON|exceeds the available context size/i.test((e as Error)?.message ?? '')

/** Raccourcit un long texte en gardant le début et la fin. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.4)
  return `${text.slice(0, head)}\n[… ${text.length - max} caractères omis pour tenir dans la mémoire du modèle …]\n${text.slice(-(max - head))}`
}

/** Arguments d'un ancien appel d'outil, allégés : un contenu déjà écrit n'a pas besoin d'être renvoyé en entier. */
function lightArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args))
    out[k] = typeof v === 'string' && v.length > 600 ? `${v.slice(0, 200)}\n[… suite déjà envoyée (${v.length} caractères au total) : relire le fichier pour la voir]` : v
  return out
}

/** Résume des messages (et un éventuel résumé précédent) pour qu'un autre modèle puisse reprendre le fil. */
async function summarize(
  msgs: Message[],
  previous: string | undefined,
  model: string,
  info: ModelInfo | undefined,
  numCtx: number,
  signal: AbortSignal,
): Promise<string> {
  const parts: string[] = previous ? [`[Résumé précédent]\n${previous}`] : []
  for (const m of msgs) {
    const who = m.role === 'user' ? 'Utilisateur' : `Assistant (${prettyName(m.model ?? '')})`
    const text = m.content.length > 3000 ? `${m.content.slice(0, 3000)} […]` : m.content
    const files = m.attachments?.map((a) => a.name).join(', ')
    const tools = m.toolCalls?.map((t) => `${t.name} ${JSON.stringify(t.args).slice(0, 140)} → ${t.status}`).join(' ; ')
    parts.push(`${who} : ${text}${files ? `\n(pièces jointes : ${files})` : ''}${tools ? `\n(actions : ${tools})` : ''}`)
  }
  // Garde la fin si le texte à résumer dépasse lui-même la mémoire du modèle
  let transcript = parts.join('\n\n')
  const maxChars = Math.floor(numCtx * 0.6 * 3.5)
  if (transcript.length > maxChars) transcript = `[…]\n${transcript.slice(-maxChars)}`
  let out = ''
  await ollama.chat(
    {
      model,
      messages: [
        { role: 'system', content: 'Tu résumes fidèlement des conversations, en français.' },
        {
          role: 'user',
          content:
            "Résume cette conversation pour qu'un autre assistant puisse la reprendre sans rien perdre d'important : " +
            "objectif de l'utilisateur, faits et décisions, fichiers et code (noms, chemins, points clés), tâches en cours ou à faire. " +
            `Liste à puces, 250 mots maximum.\n\n---\n${transcript}`,
        },
      ],
      options: { temperature: 0.2, num_ctx: numCtx },
      ...(supportsThinking(info) ? { think: false } : {}),
    },
    (c) => {
      out += c.message?.content ?? ''
    },
    signal,
  )
  return out.trim()
}

/**
 * `compact` allège l'historique quand la mémoire du modèle déborde :
 * 1 = longues sorties d'outils des étapes passées raccourcies ; 2 = en plus, contenus déjà écrits par les outils réduits
 * à leur début ; 3 = en dernier recours, la dernière étape aussi (sortie gardée plus longue : le modèle en a besoin).
 */
function buildMessages(msgs: Message[], system: string, vision: boolean, summary?: Conversation['summary'], compact = 0): ApiMessage[] {
  const out: ApiMessage[] = []
  // Avec un résumé, les messages qu'il couvre sont remplacés par lui.
  const cut = summary ? msgs.findIndex((m) => m.id === summary.uptoId) : -1
  const sys = [system.trim(), cut >= 0 && summary ? `Résumé de la conversation jusqu'ici :\n${summary.text}` : ''].filter(Boolean).join('\n\n')
  if (sys) out.push({ role: 'system', content: sys })
  const kept = cut >= 0 ? msgs.slice(cut + 1) : msgs
  const lastAssistant = kept.findLastIndex((m) => m.role === 'assistant')
  for (const [i, m] of kept.entries()) {
    const latest = i >= lastAssistant
    const old = compact > 0 && (!latest || compact >= 3)
    const maxOut = latest ? 6000 : compact >= 2 ? 600 : 1500
    if (m.role === 'user') {
      const files = (m.attachments ?? []).filter((a) => a.kind === 'file')
      const parts = files.map((f) => `Fichier joint « ${f.name} » :\n\`\`\`${langFromFilename(f.name)}\n${f.text ?? ''}\n\`\`\``)
      if (m.content) parts.push(m.content)
      const images = vision
        ? (m.attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl).map((a) => a.dataUrl!.split(',')[1])
        : []
      out.push({ role: 'user', content: parts.join('\n\n'), ...(images.length ? { images } : {}) })
    } else {
      const calls = m.toolCalls?.filter((t) => t.status !== 'pending' && t.status !== 'running') ?? []
      if ((!m.content.trim() || m.error) && !calls.length) continue
      // Renvoyée telle quelle, une réponse coupée en pleine phrase pousse le modèle à couper aussi les suivantes.
      const content = m.error ? '' : m.stopped ? `${m.content}\n\n[Réponse interrompue par l'utilisateur avant la fin.]` : m.content
      out.push({
        role: 'assistant',
        content,
        ...(calls.length
          ? { tool_calls: calls.map((t) => ({ id: t.id, function: { name: t.name, arguments: old && compact >= 2 ? lightArgs(t.args) : t.args } })) }
          : {}),
      })
      // Résultat de chaque outil (et la capture d'écran pour les modèles « Vision »)
      for (const t of calls) {
        const image = vision && t.image ? [t.image.split(',')[1]] : undefined
        const output = t.output ?? (t.status === 'denied' ? "Refusé par l'utilisateur." : '')
        out.push({
          role: 'tool',
          tool_name: t.name,
          tool_call_id: t.id,
          content: old ? clip(output, maxOut) : output,
          ...(image ? { images: image } : {}),
        })
      }
    }
  }
  return out
}

/**
 * « Ouvre… » → mode Agent ; « cherche… », « météo… » → Web ; « teste ce programme », « compile », « sous Windows… » → Labo :
 * activés tout seuls (option, activée par défaut). Tester du code passe par le labo, pas par l'ordinateur.
 */
function autoEnableTools(text: string, model: string) {
  const s = useStore.getState()
  if (!s.autoTools || !text) return
  const labWanted = wantsLab(text)
  const action = wantsAction(text) && !labWanted && !s.agentMode
  const web = wantsWeb(text) && !s.webSearch
  const lab = labWanted && !s.labMode
  if (!action && !web && !lab) return
  if (!supportsTools(s.runtime.models.find((m) => m.name === model))) {
    toast(`${prettyName(model)} ne sait pas utiliser d'outils : choisissez un modèle avec la capacité « Outils » pour ${action ? 'agir sur l’ordinateur' : lab ? 'tester dans le labo' : 'chercher sur Internet'}.`, 'danger')
    return
  }
  if (action) s.setAgentMode(true)
  if (web) s.setWebSearch(true)
  if (lab) s.setLabMode(true)
  const on = [action && 'Mode Agent', web && 'Recherche web', lab && 'Labo'].filter(Boolean) as string[]
  toast(`${on.length > 1 ? `${on.slice(0, -1).join(', ')} et ${on[on.length - 1]}` : on[0]} activé${on.length > 1 ? 's' : ''} pour cette demande.`, 'success')
}

/** Envoie le brouillon, ou `text` (conversation vocale : le brouillon tapé n'est alors pas touché). */
export async function send(text_?: string, opts?: { think?: boolean }) {
  const s = useStore.getState()
  const text = (text_ ?? s.draft.text).trim()
  const attachments = text_ === undefined ? s.draft.attachments : []
  if (!text && !attachments.length) return
  const model = s.selectedModel
  if (!model) {
    toast('Aucun modèle disponible — installez-en un dans « Modèles locaux ».', 'danger')
    return
  }
  let convId = s.activeId && s.conversations[s.activeId] ? s.activeId : null
  if (convId && s.streaming[convId]) return
  autoEnableTools(text, model)
  if (!convId) convId = s.createConversation(model)
  const conv = useStore.getState().conversations[convId]
  if (conv.messages.length === 0) s.updateConversation(convId, { title: makeTitle(text, attachments), model })
  else if (conv.model !== model) s.updateConversation(convId, { model })

  s.appendMessage(convId, { id: uid(), role: 'user', content: text, attachments: attachments.length ? attachments : undefined, createdAt: Date.now() })
  if (text_ === undefined) s.setDraft({ text: '', attachments: [] })
  await generate(convId, opts)
}

/**
 * Régénérer / Réessayer / Relancer : par défaut, on REPREND. Le travail déjà fait (étapes d'agent dont des outils ont
 * abouti : fichiers écrits, programmes compilés, commandes lancées) est gardé, et seule la dernière étape est refaite
 * (celle qui a échoué ou a été interrompue, ou la réponse finale) : le modèle repart des résultats déjà obtenus.
 * `restart` : tout recommencer (toute la dernière réponse est retirée) ; `onlyLast` : refaire la dernière étape.
 */
export async function regenerate(convId: string, opts?: { think?: boolean; onlyLast?: boolean; restart?: boolean }) {
  const s = useStore.getState()
  const conv = s.conversations[convId]
  if (!conv || s.streaming[convId]) return
  const msgs = conv.messages
  if (opts?.restart) {
    for (let i = msgs.length - 1; i >= 0 && msgs[i].role === 'assistant'; i--) s.removeMessage(convId, msgs[i].id)
  } else {
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') {
      // Une étape dont des outils ont vraiment tourné est gardée, même s'ils ont échoué (erreur de compilation, test
      // raté : c'est un résultat) ; le modèle continue à partir de là. Une étape coupée (génération en erreur ou
      // interrompue, outils interrompus ou non lancés) ou la réponse finale est refaite.
      const ran = (t: ToolCall) =>
        t.status === 'done' || (t.status === 'error' && !/^(Interrompu|Pont de l'agent injoignable|Outil (non activé|inconnu))/.test(t.output ?? ''))
      const keep = !opts?.onlyLast && !last.error && !last.stopped && !!last.toolCalls?.some(ran)
      if (!keep) s.removeMessage(convId, last.id)
      else
        for (const t of last.toolCalls ?? [])
          if (t.status === 'pending' || t.status === 'running')
            s.patchToolCall(convId, last.id, t.id, { status: 'error', needsApproval: false, output: 'Interrompu avant la fin : à refaire si besoin.' })
    }
  }
  await generate(convId, { think: opts?.think })
}

export const stop = (convId: string) => controllers.get(convId)?.abort()

/** Coupe la réflexion en cours et relance cette étape sans réfléchir. */
export async function answerWithoutThinking(convId: string) {
  stop(convId)
  await runs.get(convId)
  await regenerate(convId, { think: false, onlyLast: true })
}

// ---------- Validation des actions de l'agent ----------
type Decision = 'allow' | 'always' | 'deny'
const approvals = new Map<string, (d: Decision) => void>()

/** Appelé par la carte d'outil (Autoriser / Toujours / Refuser). */
export const decideTool = (callId: string, d: Decision) => approvals.get(callId)?.(d)

function waitDecision(callId: string, signal: AbortSignal): Promise<Decision> {
  return new Promise((resolve) => {
    const done = (d: Decision) => {
      approvals.delete(callId)
      signal.removeEventListener('abort', onAbort)
      resolve(d)
    }
    const onAbort = () => done('deny')
    approvals.set(callId, done)
    if (signal.aborted) done('deny')
    else signal.addEventListener('abort', onAbort)
  })
}

const MAX_STEPS = 12

/** Outils exécutés par l'interface : profil matériel et installation de modèles. */
async function runClientTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'system_info') {
    const hw = await fetchHardware()
    const models = useStore.getState().runtime.models.filter(isChatModel)
    const lim = fluidLimit(hw)
    const pref = useStore.getState().modelVariant
    const lines = [
      `Machine : ${describeMachine(hw)}${hw.diskFreeGB != null ? ` · ${Math.round(hw.diskFreeGB)} Go libres` : ''}`,
      `Limite pour un modèle fluide : ≈ ${lim.sizeGB.toFixed(1)} Go (≈ ${Math.round(lim.paramsB)} milliards de paramètres en Q4)`,
      '',
      'Modèles installés :',
      ...(models.length
        ? models.map((m) => `- ${m.name} (${GiB(m.size).toFixed(1)} Go) : ${FIT_INFO[fitOf(GiB(m.size), hw)].label}`)
        : ['- aucun']),
      '',
      `Préférence de l'utilisateur : versions ${VARIANT_LABEL[pref].toLowerCase()}s.`,
      ...(['standard', 'uncensored'] as Variant[]).flatMap((v) => [
        '',
        `Conseillés pour cette machine — versions ${VARIANT_LABEL[v].toLowerCase()}s (le plus capable qui reste fluide, par usage) :`,
        ...recommend(hw, v).map(
          (r) =>
            `- ${CATEGORY_LABEL[r.category]} (${CATEGORY_HINT[r.category]}) : ${r.model.name} (≈ ${r.model.sizeGB} Go, ${FIT_INFO[r.fit].label}${variantOf(r.model) !== v ? ', pas de version non censurée qui tienne' : ''})${models.some((m) => m.name === r.model.name) ? ' — déjà installé' : ''}`,
        ),
      ]),
      '',
      'Autres modèles du catalogue :',
      ...CATALOG.map(
        (c) =>
          `- ${c.name} (≈ ${c.sizeGB} Go, ${[c.category, ...(c.alsoFor ?? [])].map((k) => CATEGORY_LABEL[k]).join(' / ')}, ${VARIANT_LABEL[variantOf(c)].toLowerCase()}) : ${FIT_INFO[fitOf(c.sizeGB, hw)].label}`,
      ),
      '',
      "Images : Ollama ne génère plus d'images de type photo. Lumen fait dessiner les images en SVG (logos, icônes, illustrations) : les modèles « Images » (Code, Qwen3) dessinent le mieux.",
    ]
    return { ok: true, output: lines.join('\n') }
  }
  if (name === 'web_search') return webSearch(String(args.query ?? ''), Number(args.max_results) || 5)
  if (name === 'web_fetch') return webFetch(String(args.url ?? ''))
  if (name === 'weather') return weather(String(args.location ?? '').trim() || useStore.getState().userCity, Number(args.days) || 3)
  if (name === 'install_model') {
    const model = String(args.name ?? '').trim()
    if (!model) return { ok: false, output: 'Paramètre « name » manquant.' }
    const r = await startPull(model)
    return r.ok ? { ok: true, output: `Installé : ${model}` } : { ok: false, output: `Échec de l'installation de ${model} : ${r.error}` }
  }
  return { ok: false, output: `Outil inconnu : ${name}` }
}

async function generate(convId: string, opts?: { think?: boolean }) {
  let release!: () => void
  runs.set(convId, new Promise<void>((r) => (release = r)))
  const ctrl = new AbortController()
  controllers.set(convId, ctrl)
  useStore.getState().setStreaming(convId, true)
  try {
    // Boucle d'agent : le modèle répond, demande des outils, reçoit les résultats, et continue.
    for (let step = 0; step < MAX_STEPS; step++) {
      const { msgId, calls } = await runGeneration(convId, ctrl.signal, opts)
      if (!calls.length || ctrl.signal.aborted) break
      await executeTools(convId, msgId, ctrl.signal)
      if (ctrl.signal.aborted) break
      if (step === MAX_STEPS - 1) toast(`L'agent s'est arrêté après ${MAX_STEPS} étapes.`)
    }
  } finally {
    controllers.delete(convId)
    useStore.getState().setStreaming(convId, false)
    runs.delete(convId)
    release()
    void useStore.getState().refreshRuntime()
  }
}

async function executeTools(convId: string, msgId: string, signal: AbortSignal) {
  const s = useStore.getState()
  const calls = s.conversations[convId]?.messages.find((m) => m.id === msgId)?.toolCalls ?? []
  const patch = (id: string, p: Partial<ToolCall>) => useStore.getState().patchToolCall(convId, msgId, id, p)
  let info: Awaited<ReturnType<typeof agentInfo>>
  try {
    info = await agentInfo()
  } catch (e) {
    for (const c of calls) patch(c.id, { status: 'error', output: (e as Error).message })
    return
  }
  let cwd = s.conversations[convId]?.cwd || s.agentCwd || info.home
  for (const call of calls) {
    if (signal.aborted) {
      patch(call.id, { status: 'denied', needsApproval: false, output: "Arrêté par l'utilisateur." })
      continue
    }
    if (!TOOL_NAMES.has(call.name)) {
      patch(call.id, { status: 'error', output: `Outil inconnu : ${call.name}` })
      continue
    }
    // Un outil n'est utilisable que si son option est activée (mode Agent, Recherche Internet, ou Labo)
    const st = useStore.getState()
    const kind = WEB_TOOL_NAMES.has(call.name) ? 'web' : LAB_TOOL_NAMES.has(call.name) ? 'lab' : 'agent'
    if (kind === 'web' ? !st.webSearch : kind === 'lab' ? !st.labMode : !st.agentMode) {
      const why = kind === 'web' ? 'La recherche Internet est désactivée.' : kind === 'lab' ? 'Le labo est désactivé.' : 'Le mode Agent est désactivé.'
      patch(call.id, { status: 'error', output: `Outil non activé : ${call.name}. ${why}` })
      continue
    }
    const allowed = useStore.getState().conversations[convId]?.allowedTools ?? []
    if (needsApproval(call.name, call.args, cwd, info.home, allowed)) {
      patch(call.id, { status: 'pending', needsApproval: true })
      const d = await waitDecision(call.id, signal)
      if (d === 'deny') {
        patch(call.id, { status: 'denied', needsApproval: false, output: signal.aborted ? "Arrêté par l'utilisateur." : "Refusé par l'utilisateur." })
        continue
      }
      if (d === 'always') useStore.getState().updateConversation(convId, { allowedTools: [...new Set([...allowed, call.name])] })
    }
    patch(call.id, { status: 'running', needsApproval: false })
    try {
      const r = CLIENT_TOOLS.has(call.name) ? await runClientTool(call.name, call.args) : await callTool(call.name, call.args, cwd)
      patch(call.id, { status: r.ok ? 'done' : 'error', output: r.output, ...(r.image ? { image: r.image } : {}) })
      if (call.name === 'set_working_dir' && r.ok && r.cwd) {
        cwd = r.cwd
        useStore.getState().updateConversation(convId, { cwd })
      }
    } catch (e) {
      patch(call.id, { status: 'error', output: `Pont de l'agent injoignable : ${(e as Error).message}` })
    }
  }
}

const VOICE_PROMPT = [
  "Conversation vocale : tu t'appelles Lumen et ta réponse est lue à voix haute, comme un assistant vocal (à la manière de Jarvis).",
  '- Réponds en phrases courtes et naturelles, à l’oral : en général 1 à 4 phrases, plus seulement si on te le demande.',
  "- Pas de tableau, pas de longue liste, pas d'emoji ni de symbole ; écris les nombres et unités simplement.",
  "- Si du code ou un long contenu est utile, mets-le dans un bloc et annonce-le en une phrase (il s'affiche à l'écran).",
  "- Ce que tu reçois est la transcription de la voix de l'utilisateur : des mots peuvent être mal compris, devine le sens.",
].join('\n')

const IMAGE_PROMPT = [
  "L'utilisateur veut une image. Tu la crées en dessinant un SVG, que l'interface affiche directement comme une image (téléchargeable en SVG et PNG).",
  "- Réponds par une phrase courte, puis un seul bloc ```svg contenant un SVG complet et autonome : <svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 L H\" width=\"L\" height=\"H\"> (512 × 512 par défaut, 1200 × 630 pour une bannière).",
  '- Soigne le rendu : composition centrée et équilibrée, palette harmonieuse, dégradés et ombres douces dans <defs>, formes et chemins précis, fond adapté.',
  "- Pas de script, pas d'image ni de police externes ; le texte éventuel utilise font-family=\"sans-serif\".",
  '- Après le bloc, une ou deux lignes : ce que montre le dessin et des variantes possibles (couleurs, style, format).',
  "Ne dis pas que tu ne peux pas créer d'image : dessine-la.",
].join('\n')

async function runGeneration(convId: string, signal: AbortSignal, opts?: { think?: boolean }): Promise<{ msgId: string; calls: ToolCall[] }> {
  const s = useStore.getState()
  const model = s.selectedModel
  const info = s.runtime.models.find((m) => m.name === model)
  const settings = s.settingsFor(model)
  const conv = s.conversations[convId]
  const vision = supportsVision(info)
  const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user')
  const prev = conv.messages[conv.messages.length - 1]
  const mode = thinkModeOf(settings.think)
  const think = opts?.think ?? (mode === 'auto' ? shouldThink(lastUser) : mode === 'on')
  if (!vision && lastUser?.attachments?.some((a) => a.kind === 'image') && prev?.role === 'user')
    toast("Ce modèle ne lit pas les images : elles ne lui sont pas envoyées.", 'danger')

  // Mode agent : outils + consignes système décrivant l'ordinateur ; Recherche Internet : outils web (option)
  let agent = s.agentMode && supportsTools(info)
  const web = s.webSearch && supportsTools(info)
  let system = settings.system
  if (agent) {
    try {
      const ai = await agentInfo()
      const extra = settings.system.trim() ? `\n\nConsignes de l'utilisateur :\n${settings.system.trim()}` : ''
      system = agentSystemPrompt(ai, conv.cwd || s.agentCwd || ai.home) + extra
    } catch (e) {
      agent = false
      toast(`Mode agent indisponible : ${(e as Error).message}`, 'danger')
    }
  }

  if (web) system = [system.trim(), webSystemPrompt(s.userCity)].filter(Boolean).join('\n\n')
  // Labos isolés (Linux, Windows, Android) : l'IA y compile et teste pour de vrai
  const lab = s.labMode && supportsTools(info)
  const bridgeInfo = agent || lab ? await agentInfo().catch(() => null) : null
  if (lab) system = [system.trim(), labSystemPrompt(bridgeInfo?.arch)].filter(Boolean).join('\n\n')
  if (voiceActive()) system = [system.trim(), VOICE_PROMPT].filter(Boolean).join('\n\n')
  // AppleScript n'existe que sur macOS : inutile de le proposer au modèle ailleurs
  const platform = agent ? bridgeInfo?.platform : undefined
  const agentTools = TOOLS.filter((t) => t.function.name !== 'applescript' || platform === 'darwin')
  const tools = [...(agent ? agentTools : []), ...(lab ? LAB_TOOLS : []), ...(web ? WEB_TOOLS : [])]
  const numCtx = contextFor(settings.num_ctx, tools.length > 0, info, s.lowMemory)

  // Demande d'image : Ollama ne génère pas de photo, le modèle dessine en SVG (affiché comme une image dans le fil)
  if (lastUser && detectTask(lastUser.content, !!lastUser.attachments?.some((a) => a.kind === 'image')) === 'image')
    system = [
      system.trim(),
      IMAGE_PROMPT,
      agent ? "Pour dessiner, n'utilise aucun outil : écris le bloc svg dans ta réponse. Seulement si l'utilisateur demande d'enregistrer l'image, écris aussi ce SVG avec write_file." : '',
    ].filter(Boolean).join('\n\n')

  const isStep = prev?.role === 'assistant'
  const assistant: Message = {
    id: uid(), role: 'assistant', content: '', model, createdAt: Date.now(), streaming: true,
    ...(isStep ? { agentStep: true } : {}),
  }
  s.appendMessage(convId, assistant)
  const patch = (p: Partial<Message>) => useStore.getState().patchMessage(convId, assistant.id, p)

  // ---------- Passage de relais entre modèles / mémoire trop pleine ----------
  let summary = conv.summary
  if (!isStep) {
    const prevModel = [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.model)?.model
    const handoff = !!prevModel && prevModel !== model
    const lastUserIdx = conv.messages.length - 1 // le message de l'utilisateur qu'on traite
    const start = summary ? conv.messages.findIndex((m) => m.id === summary!.uptoId) + 1 : 0
    const older = conv.messages.slice(Math.max(0, start), lastUserIdx)
    // Consignes et définitions d'outils comptent aussi : avec l'agent, elles prennent à elles seules une bonne part de la mémoire.
    const fixed = tokensOf(system) + (tools.length ? tokensOf(JSON.stringify(tools)) : 0)
    const tooLong = fixed + estimateTokens(conv.messages.slice(Math.max(0, start)), summary?.text) > numCtx * 0.7
    const wantSummary = older.length >= 2 && ((handoff && s.handoffMode === 'summary') || tooLong)
    if (wantSummary) {
      patch({ phase: 'summarizing' })
      try {
        // Même mémoire que la réponse qui suit : sinon Ollama recharge le modèle deux fois
        const text = await summarize(older, summary?.text, model, info, numCtx, signal)
        if (text) {
          summary = { text, uptoId: older[older.length - 1].id, model, count: (summary?.count ?? 0) + older.length }
          useStore.getState().updateConversation(convId, { summary })
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          patch({ phase: undefined, streaming: false, stopped: true })
          return { msgId: assistant.id, calls: [] }
        }
        toast(`Résumé impossible, envoi de l'historique complet : ${(e as Error).message}`, 'danger')
      }
      patch({ phase: undefined })
    }
    const summarized = !!summary && conv.messages.some((m) => m.id === summary!.uptoId)
    if (handoff || wantSummary) {
      patch({ context: { from: handoff ? prevModel : undefined, mode: summarized ? 'summary' : 'full', count: lastUserIdx } })
    }
    if (handoff) {
      system = [
        system.trim(),
        `Tu prends le relais dans une conversation commencée avec un autre modèle (${prettyName(prevModel!)}). ` +
          (summarized ? 'Le résumé et les derniers messages ci-dessous' : "Tout l'historique ci-dessous") +
          ' te donnent le contexte : tiens-en compte et garde la continuité (fichiers, décisions, ton).',
      ].filter(Boolean).join('\n\n')
    }
  }

  // Avant chaque requête (étapes de l'agent comprises) : si l'historique ne laisse pas assez de place pour la réponse,
  // les étapes passées sont allégées. Sans cela, un long fichier écrit par un outil est coupé net au bout de la mémoire.
  let level = 0
  let history = buildMessages(conv.messages, system, vision, summary)
  while (level < 3 && estimateRequest(history, tools) > numCtx * (1 - ANSWER_RESERVE))
    history = buildMessages(conv.messages, system, vision, summary, ++level)
  const native: ApiToolCall[] = []
  let content = ''
  let thinking = ''
  let thinkStart: number | null = null
  let thinkEnd: number | null = null
  let stats: Stats | undefined
  let raf = 0
  const flushNow = () => {
    raf = 0
    patch({ content, thinking: thinking || undefined })
  }
  const thinkingSeconds = () =>
    thinkStart === null ? undefined : ((thinkEnd ?? performance.now()) - thinkStart) / 1000

  const request = (messages: ApiMessage[]) =>
    ollama.chat(
      {
        model,
        messages,
        options: {
          temperature: settings.temperature,
          top_p: settings.top_p,
          repeat_penalty: settings.repeat_penalty,
          num_ctx: numCtx,
        },
        ...(supportsThinking(info) ? { think } : {}),
        ...(settings.keepLoaded ? { keep_alive: -1 } : {}),
        ...(tools.length ? { tools } : {}),
      },
      (c) => {
        const t = c.message?.thinking
        const d = c.message?.content
        if (c.message?.tool_calls?.length) native.push(...c.message.tool_calls)
        if (t) {
          thinkStart ??= performance.now()
          thinking += t
        }
        if (d) {
          if (thinkStart !== null && thinkEnd === null) thinkEnd = performance.now()
          content += d
        }
        if (c.done) {
          const evalCount = c.eval_count ?? 0
          stats = {
            evalCount,
            promptCount: c.prompt_eval_count ?? 0,
            tps: evalCount && c.eval_duration ? evalCount / (c.eval_duration / 1e9) : 0,
            seconds: (c.total_duration ?? 0) / 1e9,
            loadSeconds: (c.load_duration ?? 0) / 1e9,
            ctx: numCtx,
          }
        }
        if (!raf) raf = requestAnimationFrame(flushNow)
      },
      signal,
    )

  try {
    for (;;) {
      try {
        await request(history)
        break
      } catch (e) {
        // Mémoire pleine malgré l'estimation : une nouvelle tentative, l'historique allégé au maximum.
        if (!isContextFull(e) || level >= 3 || signal.aborted) throw e
        history = buildMessages(conv.messages, system, vision, summary, (level = 3))
        content = ''
        thinking = ''
        native.length = 0
        thinkStart = thinkEnd = null
        patch({ content: '', thinking: undefined })
      }
    }
    cancelAnimationFrame(raf)

    // Appels d'outils natifs, sinon écrits en JSON dans le texte par les modèles qui ne les gèrent pas nativement.
    let calls: ToolCall[] = native.map((tc) => ({
      id: tc.id || uid(),
      name: tc.function.name,
      args: tc.function.arguments ?? {},
      status: 'pending' as const,
    }))
    if (tools.length && !calls.length) {
      const parsed = parseTextToolCalls(content)
      if (parsed.calls.length) {
        calls = parsed.calls.map((c) => ({ id: uid(), name: c.name, args: c.args, status: 'pending' as const }))
        content = parsed.cleaned
      }
    }

    patch({
      content,
      thinking: thinking || undefined,
      thinkingSeconds: thinkingSeconds(),
      streaming: false,
      stats,
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(!content.trim() && !thinking.trim() && !calls.length ? { error: 'Le modèle a renvoyé une réponse vide.' } : {}),
    })
    if (stats?.tps) useStore.getState().pushTps(stats.tps)
    return { msgId: assistant.id, calls }
  } catch (e) {
    cancelAnimationFrame(raf)
    const aborted = (e as Error).name === 'AbortError'
    patch({
      content,
      thinking: thinking || undefined,
      thinkingSeconds: thinkingSeconds(),
      streaming: false,
      ...(aborted
        ? { stopped: true }
        : {
            error: isContextFull(e)
              ? `Mémoire du modèle pleine (${formatCtx(numCtx)} jetons), même après avoir allégé l'historique. ` +
                'Agrandissez sa mémoire (Modèles → réglages du modèle → Mémoire « Longue »), demandez un fichier plus court ou continuez dans une nouvelle conversation.'
              : (e as Error).message,
          }),
    })
    return { msgId: assistant.id, calls: [] }
  }
}
