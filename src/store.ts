// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval'
import { ollama, setBaseUrl as setApiBase, type ModelInfo, type RunningModel } from './lib/ollama'
import { isChatModel } from './lib/models'
import type { Strength } from './lib/strengths'
import type { Variant } from './lib/hardware'
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from './voice/catalog'
import { uid } from './lib/format'

export type Attachment = {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  size: number
  dataUrl?: string // images
  text?: string // fichiers texte / code
  width?: number
  height?: number
}

export type Stats = { evalCount: number; promptCount: number; tps: number; seconds: number; loadSeconds?: number }

export type ToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'pending' | 'running' | 'done' | 'error' | 'denied'
  needsApproval?: boolean
  output?: string
  image?: string // capture d'écran (data URL)
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  thinkingSeconds?: number
  attachments?: Attachment[]
  model?: string
  stats?: Stats
  error?: string
  stopped?: boolean
  streaming?: boolean
  toolCalls?: ToolCall[]
  agentStep?: boolean // suite d'un tour d'agent (pas de nouvel en-tête)
  /** Ce que le modèle a reçu en contexte : historique complet ou résumé (et depuis quel modèle il prend le relais). */
  context?: { from?: string; mode: 'full' | 'summary'; count: number }
  phase?: 'summarizing'
  createdAt: number
}

export type Conversation = {
  id: string
  title: string
  model: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  allowedTools?: string[] // outils autorisés « toujours » dans cette conversation
  cwd?: string // dossier de travail de l'agent pour cette conversation (set_working_dir)
  /** Résumé des messages jusqu'à `uptoId` (inclus), envoyé à la place de ces messages. */
  summary?: { text: string; uptoId: string; model: string; count: number }
}

export type HandoffMode = 'full' | 'summary'

/** auto : le modèle ne réfléchit que pour les demandes qui le justifient. */
export type ThinkMode = 'auto' | 'on' | 'off'

export type ModelSettings = {
  temperature: number
  top_p: number
  repeat_penalty: number
  num_ctx: number
  system: string
  think: ThinkMode
  keepLoaded: boolean
}

export const DEFAULT_SETTINGS: ModelSettings = {
  temperature: 0.7,
  top_p: 0.9,
  repeat_penalty: 1.1,
  num_ctx: 8192,
  system: '',
  think: 'auto',
  keepLoaded: false,
}

/** Les premières versions stockaient un booléen (true = ancien défaut → auto). */
export const thinkModeOf = (v: unknown): ThinkMode =>
  v === 'on' || v === 'off' || v === 'auto' ? v : v === false ? 'off' : 'auto'

export type Panel = { type: 'code'; key: string } | { type: 'image'; id: string } | null
export type View = 'chat' | 'models' | 'library'
export type ToastItem = { id: string; text: string; tone: 'neutral' | 'success' | 'danger' }
export type PullState = { status: string; completed?: number; total?: number; error?: string }

type Runtime = {
  connected: boolean | null
  version?: string
  models: ModelInfo[]
  running: RunningModel[]
  error?: string
}

type Persisted = {
  conversations: Record<string, Conversation>
  order: string[]
  activeId: string | null
  selectedModel: string
  modelSettings: Record<string, ModelSettings>
  baseUrl: string
  tpsHistory: number[]
  sidebarOpen: boolean
  agentMode: boolean
  agentCwd: string // '' = dossier personnel
  suggestModels: boolean
  handoffMode: HandoffMode
  modelVariant: Variant // modèles conseillés : versions standard ou non censurées
  webSearch: boolean // recherche Internet / météo pour les modèles (désactivée par défaut)
  labMode: boolean // labos isolés Linux / Windows / Android où l'IA teste des programmes (option « Labo »)
  userCity: string // ville par défaut pour la météo ('' = demander)
  autoTools: boolean // active tout seul Agent / Web selon la demande (« ouvre… », « cherche… »)
  voice: VoicePrefs // conversation vocale : voix, reconnaissance, débit, langue
  draft: { text: string; attachments: Attachment[] } // le texte en cours survit à un rechargement (pas les pièces jointes)
  modelStrengths: Record<string, Strength[]>
  onboarded: boolean // accueil du premier lancement déjà vu
}

export type State = Persisted & {
  view: View
  panel: Panel
  streaming: Record<string, boolean>
  runtime: Runtime
  toasts: ToastItem[]
  pulls: Record<string, PullState>
  settingsOpen: boolean
  searchTick: number
  composerTick: number
  hydrated: boolean

  newChat: () => void
  openConversation: (id: string) => void
  createConversation: (model: string) => string
  updateConversation: (id: string, patch: Partial<Conversation>) => void
  deleteConversation: (id: string) => void
  clearAll: () => void
  appendMessage: (convId: string, msg: Message) => void
  patchMessage: (convId: string, msgId: string, patch: Partial<Message>) => void
  removeMessage: (convId: string, msgId: string) => void
  setModel: (name: string) => void
  settingsFor: (model: string) => ModelSettings
  updateSettings: (model: string, patch: Partial<ModelSettings>) => void
  resetSettings: (model: string) => void
  setView: (v: View) => void
  openPanel: (p: Panel) => void
  setBaseUrl: (url: string) => void
  toggleSidebar: () => void
  setDraft: (patch: Partial<State['draft']>) => void
  addDraftAttachments: (a: Attachment[]) => void
  removeDraftAttachment: (id: string) => void
  setStreaming: (convId: string, on: boolean) => void
  pushTps: (tps: number) => void
  refreshRuntime: (full?: boolean) => Promise<void>
  setPull: (name: string, s: PullState | null) => void
  setSettingsOpen: (open: boolean) => void
  focusSearch: () => void
  focusComposer: () => void
  setAgentMode: (on: boolean) => void
  setAgentCwd: (cwd: string) => void
  setSuggestModels: (on: boolean) => void
  setHandoffMode: (mode: HandoffMode) => void
  setModelVariant: (v: Variant) => void
  setWebSearch: (on: boolean) => void
  setLabMode: (on: boolean) => void
  setUserCity: (city: string) => void
  setAutoTools: (on: boolean) => void
  setVoicePrefs: (patch: Partial<VoicePrefs>) => void
  setModelStrengths: (model: string, list: Strength[] | null) => void
  onboardingOpen: boolean
  setOnboarding: (open: boolean) => void
  /** Machine ≤ 6 Go : contexte par défaut réduit à 4k pour que les petits modèles tiennent en mémoire. */
  lowMemory: boolean
  setLowMemory: (low: boolean) => void
  defaultSettings: () => ModelSettings
  patchToolCall: (convId: string, msgId: string, callId: string, patch: Partial<ToolCall>) => void
}

// --- Persistance IndexedDB, écrite au plus toutes les 600 ms (évite de sérialiser à chaque token)
const STORE_KEY = 'lumen'
let pending: StorageValue<Persisted> | null = null
let pendingSince = 0
let timer: ReturnType<typeof setTimeout> | undefined
const flush = () => {
  clearTimeout(timer)
  if (!pending) return
  const v = pending
  pending = null
  pendingSince = 0
  idbSet(STORE_KEY, v).catch((e) => console.error('Sauvegarde impossible', e))
}
const storage: PersistStorage<Persisted> = {
  getItem: async (name) => (await idbGet<StorageValue<Persisted>>(name)) ?? null,
  setItem: (_name, value) => {
    pending = value
    pendingSince ||= Date.now()
    clearTimeout(timer)
    // Pendant un long streaming, on sauvegarde quand même au moins toutes les 3 s.
    if (Date.now() - pendingSince > 3000) flush()
    else timer = setTimeout(flush, 600)
  },
  removeItem: (name) => idbDel(name),
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush())
}

const mapConv = (s: State, id: string, fn: (c: Conversation) => Conversation) => {
  const c = s.conversations[id]
  return c ? { conversations: { ...s.conversations, [id]: fn(c) } } : {}
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      conversations: {},
      order: [],
      activeId: null,
      selectedModel: '',
      modelSettings: {},
      baseUrl: '/ollama',
      tpsHistory: [],
      sidebarOpen: true,
      agentMode: false,
      agentCwd: '',
      suggestModels: true,
      handoffMode: 'full',
      modelVariant: 'standard',
      webSearch: false,
      labMode: false,
      userCity: '',
      autoTools: true,
      voice: DEFAULT_VOICE_PREFS,
      modelStrengths: {},
      onboarded: false,
      onboardingOpen: false,
      lowMemory: false,

      view: 'chat',
      panel: null,
      streaming: {},
      runtime: { connected: null, models: [], running: [] },
      draft: { text: '', attachments: [] },
      toasts: [],
      pulls: {},
      settingsOpen: false,
      searchTick: 0,
      composerTick: 0,
      hydrated: false,

      newChat: () => set({ activeId: null, view: 'chat', panel: null, composerTick: get().composerTick + 1 }),

      openConversation: (id) => {
        const c = get().conversations[id]
        if (!c) return
        const installed = get().runtime.models.some((m) => m.name === c.model)
        set({ activeId: id, view: 'chat', panel: null, ...(installed ? { selectedModel: c.model } : {}) })
      },

      createConversation: (model) => {
        const id = uid()
        const now = Date.now()
        set((s) => ({
          conversations: { ...s.conversations, [id]: { id, title: 'Nouvelle conversation', model, messages: [], createdAt: now, updatedAt: now } },
          order: [id, ...s.order],
          activeId: id,
        }))
        return id
      },

      updateConversation: (id, patch) => set((s) => mapConv(s, id, (c) => ({ ...c, ...patch }))),

      deleteConversation: (id) =>
        set((s) => {
          const conversations = { ...s.conversations }
          delete conversations[id]
          return {
            conversations,
            order: s.order.filter((x) => x !== id),
            ...(s.activeId === id ? { activeId: null, panel: null } : {}),
          }
        }),

      clearAll: () => set({ conversations: {}, order: [], activeId: null, panel: null }),

      appendMessage: (convId, msg) =>
        set((s) => {
          const res = mapConv(s, convId, (c) => ({ ...c, messages: [...c.messages, msg], updatedAt: Date.now() }))
          return msg.role === 'user' ? { ...res, order: [convId, ...s.order.filter((x) => x !== convId)] } : res
        }),

      patchMessage: (convId, msgId, patch) =>
        set((s) =>
          mapConv(s, convId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
          })),
        ),

      removeMessage: (convId, msgId) =>
        set((s) => mapConv(s, convId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== msgId) }))),

      setModel: (name) => {
        set({ selectedModel: name })
        const id = get().activeId
        if (id && get().conversations[id]) get().updateConversation(id, { model: name })
      },

      settingsFor: (model) => get().modelSettings[model] ?? get().defaultSettings(),

      defaultSettings: () => (get().lowMemory ? { ...DEFAULT_SETTINGS, num_ctx: 4096 } : DEFAULT_SETTINGS),
      setLowMemory: (lowMemory) => set({ lowMemory }),

      updateSettings: (model, patch) =>
        set((s) => ({ modelSettings: { ...s.modelSettings, [model]: { ...(s.modelSettings[model] ?? s.defaultSettings()), ...patch } } })),

      resetSettings: (model) =>
        set((s) => {
          const modelSettings = { ...s.modelSettings }
          delete modelSettings[model]
          return { modelSettings }
        }),

      setView: (view) => set({ view, panel: view === 'chat' ? get().panel : null }),
      openPanel: (panel) => set({ panel }),

      setBaseUrl: (url) => {
        const clean = url.trim().replace(/\/+$/, '') || '/ollama'
        setApiBase(clean)
        set({ baseUrl: clean, runtime: { connected: null, models: [], running: [] } })
        void get().refreshRuntime(true)
      },

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
      addDraftAttachments: (a) => set((s) => ({ draft: { ...s.draft, attachments: [...s.draft.attachments, ...a] } })),
      removeDraftAttachment: (id) =>
        set((s) => ({ draft: { ...s.draft, attachments: s.draft.attachments.filter((a) => a.id !== id) } })),

      setStreaming: (convId, on) =>
        set((s) => {
          const streaming = { ...s.streaming }
          if (on) streaming[convId] = true
          else delete streaming[convId]
          return { streaming }
        }),

      pushTps: (tps) => set((s) => ({ tpsHistory: [...s.tpsHistory, Math.round(tps * 10) / 10].slice(-40) })),

      refreshRuntime: async (full = false) => {
        try {
          const [v, running] = await Promise.all([ollama.version(), ollama.ps()])
          let models = get().runtime.models
          if (full || !models.length) models = await ollama.tags()
          set({ runtime: { connected: true, version: v.version, models, running } })
          if (get().hydrated) {
            const chat = models.filter(isChatModel)
            if (chat.length && !chat.some((m) => m.name === get().selectedModel)) {
              const loaded = running.find((r) => chat.some((c) => c.name === r.name))
              set({ selectedModel: loaded?.name ?? chat[0].name })
            }
          }
        } catch (e) {
          set((s) => ({ runtime: { ...s.runtime, connected: false, running: [], error: (e as Error).message } }))
        }
      },

      setPull: (name, st) =>
        set((s) => {
          const pulls = { ...s.pulls }
          if (st) pulls[name] = st
          else delete pulls[name]
          return { pulls }
        }),

      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      focusSearch: () => set((s) => ({ searchTick: s.searchTick + 1, sidebarOpen: true })),
      focusComposer: () => set((s) => ({ composerTick: s.composerTick + 1 })),
      setAgentMode: (agentMode) => set({ agentMode }),
      setAgentCwd: (agentCwd) => set({ agentCwd: agentCwd.trim() }),
      setSuggestModels: (suggestModels) => set({ suggestModels }),
      // Fermer l'accueil le marque comme vu ; il reste accessible depuis Réglages et Modèles locaux.
      setOnboarding: (open) => set(open ? { onboardingOpen: true } : { onboardingOpen: false, onboarded: true }),
      setHandoffMode: (handoffMode) => set({ handoffMode }),
      setModelVariant: (modelVariant) => set({ modelVariant }),
      setWebSearch: (webSearch) => set({ webSearch }),
      setLabMode: (labMode) => set({ labMode }),
      setUserCity: (userCity) => set({ userCity: userCity.trim() }),
      setAutoTools: (autoTools) => set({ autoTools }),
      setVoicePrefs: (patch) => set((s) => ({ voice: { ...s.voice, ...patch } })),
      setModelStrengths: (model, list) =>
        set((s) => {
          const modelStrengths = { ...s.modelStrengths }
          if (list) modelStrengths[model] = list
          else delete modelStrengths[model]
          return { modelStrengths }
        }),
      patchToolCall: (convId, msgId, callId, patch) =>
        set((s) =>
          mapConv(s, convId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === msgId && m.toolCalls ? { ...m, toolCalls: m.toolCalls.map((t) => (t.id === callId ? { ...t, ...patch } : t)) } : m,
            ),
          })),
        ),
    }),
    {
      name: STORE_KEY,
      version: 1,
      storage,
      partialize: (s): Persisted => ({
        conversations: s.conversations,
        order: s.order,
        activeId: s.activeId,
        selectedModel: s.selectedModel,
        modelSettings: s.modelSettings,
        baseUrl: s.baseUrl,
        tpsHistory: s.tpsHistory,
        sidebarOpen: s.sidebarOpen,
        agentMode: s.agentMode,
        agentCwd: s.agentCwd,
        suggestModels: s.suggestModels,
        handoffMode: s.handoffMode,
        modelVariant: s.modelVariant,
        webSearch: s.webSearch,
        labMode: s.labMode,
        userCity: s.userCity,
        autoTools: s.autoTools,
        voice: s.voice,
        draft: { text: s.draft.text, attachments: [] },
        modelStrengths: s.modelStrengths,
        onboarded: s.onboarded,
      }),
    },
  ),
)

function onHydrated() {
  const s = useStore.getState()
  setApiBase(s.baseUrl)
  // Une génération interrompue par un rechargement de page ne doit pas rester « en cours ».
  const conversations = { ...s.conversations }
  const interrupted = (t: ToolCall) => t.status === 'pending' || t.status === 'running'
  for (const [id, c] of Object.entries(conversations)) {
    if (c.messages.some((m) => m.streaming || m.toolCalls?.some(interrupted)))
      conversations[id] = {
        ...c,
        messages: c.messages.map((m) => ({
          ...m,
          ...(m.streaming ? { streaming: false, stopped: true } : {}),
          ...(m.toolCalls?.some(interrupted)
            ? { toolCalls: m.toolCalls.map((t) => (interrupted(t) ? { ...t, status: 'error' as const, output: 'Interrompu (page rechargée).' } : t)) }
            : {}),
        })),
      }
  }
  useStore.setState({ conversations, hydrated: true })
  void useStore.getState().refreshRuntime(true)
}
if (useStore.persist.hasHydrated()) onHydrated()
else useStore.persist.onFinishHydration(onHydrated)

export function toast(text: string, tone: ToastItem['tone'] = 'neutral') {
  const id = uid()
  useStore.setState((s) => ({ toasts: [...s.toasts, { id, text, tone }].slice(-4) }))
  setTimeout(() => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2800)
}
