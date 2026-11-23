// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { thinkModeOf, toast, useStore, type Attachment, type Conversation, type Message, type Stats, type ToolCall } from './store'
import { ollama, type ApiMessage, type ApiToolCall, type ModelInfo } from './lib/ollama'
import { isChatModel, prettyName, supportsThinking, supportsTools, supportsVision } from './lib/models'
import {
  agentInfo, agentSystemPrompt, callTool, CLIENT_TOOLS, needsApproval, parseTextToolCalls, TOOL_NAMES, TOOLS, WEB_TOOL_NAMES, WEB_TOOLS, webSystemPrompt,
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
import { wantsAction, wantsWeb } from './lib/intent'

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

/** Estimation grossière du nombre de tokens (≈ 3,5 caractères par token, ~800 par image). */
function estimateTokens(msgs: Message[], summaryText?: string): number {
  let chars = summaryText?.length ?? 0
  let images = 0
  for (const m of msgs) {
    chars += m.content.length
    for (const a of m.attachments ?? []) {
      if (a.kind === 'file') chars += a.text?.length ?? 0
      else images++
    }
    for (const t of m.toolCalls ?? []) chars += (t.output?.length ?? 0) + JSON.stringify(t.args).length
  }
  return chars / 3.5 + images * 800
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

function buildMessages(msgs: Message[], system: string, vision: boolean, summary?: Conversation['summary']): ApiMessage[] {
  const out: ApiMessage[] = []
  // Avec un résumé, les messages qu'il couvre sont remplacés par lui.
  const cut = summary ? msgs.findIndex((m) => m.id === summary.uptoId) : -1
  const sys = [system.trim(), cut >= 0 && summary ? `Résumé de la conversation jusqu'ici :\n${summary.text}` : ''].filter(Boolean).join('\n\n')
  if (sys) out.push({ role: 'system', content: sys })
  for (const m of cut >= 0 ? msgs.slice(cut + 1) : msgs) {
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
        ...(calls.length ? { tool_calls: calls.map((t) => ({ id: t.id, function: { name: t.name, arguments: t.args } })) } : {}),
      })
      // Résultat de chaque outil (et la capture d'écran pour les modèles « Vision »)
      for (const t of calls) {
        const image = vision && t.image ? [t.image.split(',')[1]] : undefined
        out.push({
          role: 'tool',
          tool_name: t.name,
          tool_call_id: t.id,
          content: t.output ?? (t.status === 'denied' ? "Refusé par l'utilisateur." : ''),
          ...(image ? { images: image } : {}),
        })
      }
    }
  }
  return out
}

/** « Ouvre… » → mode Agent ; « cherche… », « météo… » → Web : activés tout seuls (option, activée par défaut). */
function autoEnableTools(text: string, model: string) {
  const s = useStore.getState()
  if (!s.autoTools || !text) return
  const action = wantsAction(text) && !s.agentMode
  const web = wantsWeb(text) && !s.webSearch
  if (!action && !web) return
  if (!supportsTools(s.runtime.models.find((m) => m.name === model))) {
    toast(`${prettyName(model)} ne sait pas utiliser d'outils : choisissez un modèle avec la capacité « Outils » pour ${action ? 'agir sur l’ordinateur' : 'chercher sur Internet'}.`, 'danger')
    return
  }
  if (action) s.setAgentMode(true)
  if (web) s.setWebSearch(true)
  toast(`${[action && 'Mode Agent', web && 'Recherche web'].filter(Boolean).join(' et ')} activé${action && web ? 's' : ''} pour cette demande.`, 'success')
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

export async function regenerate(convId: string, opts?: { think?: boolean; onlyLast?: boolean }) {
  const s = useStore.getState()
  const conv = s.conversations[convId]
  if (!conv || s.streaming[convId]) return
  // Retire toute la dernière réponse, étapes d'agent comprises (ou seulement la dernière étape).
  for (let i = conv.messages.length - 1; i >= 0 && conv.messages[i].role === 'assistant'; i--) {
    s.removeMessage(convId, conv.messages[i].id)
    if (opts?.onlyLast) break
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
    // Un outil n'est utilisable que si son option est activée (mode Agent, ou Recherche Internet pour les outils web)
    const st = useStore.getState()
    if (WEB_TOOL_NAMES.has(call.name) ? !st.webSearch : !st.agentMode) {
      patch(call.id, { status: 'error', output: `Outil non activé : ${call.name}. ${WEB_TOOL_NAMES.has(call.name) ? 'La recherche Internet est désactivée.' : 'Le mode Agent est désactivé.'}` })
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
  if (voiceActive()) system = [system.trim(), VOICE_PROMPT].filter(Boolean).join('\n\n')
  // AppleScript n'existe que sur macOS : inutile de le proposer au modèle ailleurs
  const platform = agent ? (await agentInfo().catch(() => null))?.platform : undefined
  const agentTools = TOOLS.filter((t) => t.function.name !== 'applescript' || platform === 'darwin')
  const tools = [...(agent ? agentTools : []), ...(web ? WEB_TOOLS : [])]

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
    const tooLong = estimateTokens(conv.messages.slice(Math.max(0, start)), summary?.text) > settings.num_ctx * 0.7
    const wantSummary = older.length >= 2 && ((handoff && s.handoffMode === 'summary') || tooLong)
    if (wantSummary) {
      patch({ phase: 'summarizing' })
      try {
        const text = await summarize(older, summary?.text, model, info, settings.num_ctx, signal)
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

  const history = buildMessages(conv.messages, system, vision, summary)
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

  try {
    await ollama.chat(
      {
        model,
        messages: history,
        options: {
          temperature: settings.temperature,
          top_p: settings.top_p,
          repeat_penalty: settings.repeat_penalty,
          num_ctx: settings.num_ctx,
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
          }
        }
        if (!raf) raf = requestAnimationFrame(flushNow)
      },
      signal,
    )
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
      ...(aborted ? { stopped: true } : { error: (e as Error).message }),
    })
    return { msgId: assistant.id, calls: [] }
  }
}
