// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, AudioLines, Bot, Brain, ChevronDown, FileCode, FlaskConical, Folder, Globe, Lightbulb, Paperclip, ScanLine, Square, TriangleExclamationPoint, X } from 'lucide-react'
import { agentInfo } from '../lib/agent'
import { detectTask, strengthInfo, suggestModel } from '../lib/strengths'
import { thinkModeOf, useStore, type ThinkMode } from '../store'
import { addFiles, addScreenCapture, send, shouldThink, stop } from '../chat'
import { wantsAction, wantsLab, wantsWeb } from '../lib/intent'
import { startConversation } from '../voice/conversation'
import { prettyName, supportsThinking, supportsTools, supportsVision } from '../lib/models'
import { formatBytes } from '../lib/format'
import { IconButton, StatusDot } from './ui'
import { ModelPicker } from './ModelPicker'

const NEXT_THINK: Record<ThinkMode, ThinkMode> = { auto: 'on', on: 'off', off: 'auto' }
const THINK_LABEL: Record<ThinkMode, string> = { auto: 'Réflexion auto', on: 'Réflexion', off: 'Sans réflexion' }
const THINK_HINT: Record<ThinkMode, string> = {
  auto: 'Auto : le modèle réfléchit seulement pour les demandes complexes. Cliquer pour toujours réfléchir.',
  on: 'Le modèle réfléchit avant chaque réponse. Cliquer pour désactiver.',
  off: 'Réponses directes, sans réflexion. Cliquer pour revenir en auto.',
}

function autosize(ta: HTMLTextAreaElement | null) {
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`
}

export function Composer({ placeholder, autoFocus }: { placeholder: string; autoFocus?: boolean }) {
  const draft = useStore((s) => s.draft)
  const selected = useStore((s) => s.selectedModel)
  const models = useStore((s) => s.runtime.models)
  const running = useStore((s) => s.runtime.running)
  const activeId = useStore((s) => s.activeId)
  const streaming = useStore((s) => (s.activeId ? !!s.streaming[s.activeId] : false))
  const think = useStore((s) => thinkModeOf(s.modelSettings[s.selectedModel]?.think))
  const composerTick = useStore((s) => s.composerTick)
  const agentMode = useStore((s) => s.agentMode)
  const webSearch = useStore((s) => s.webSearch)
  const labMode = useStore((s) => s.labMode)
  const workDir = useStore((s) => (s.activeId ? s.conversations[s.activeId]?.cwd : undefined) || s.agentCwd)
  const { setDraft, removeDraftAttachment, updateSettings, setAgentMode, setSettingsOpen } = useStore.getState()
  const [home, setHome] = useState('')
  useEffect(() => {
    if (agentMode) agentInfo().then((i) => setHome(i.home), () => setHome(''))
  }, [agentMode])
  const cwdShown = workDir || home
  const cwdLabel = cwdShown ? (cwdShown === home ? '~' : cwdShown.replace(home, '~').split('/').slice(-2).join('/')) : ''

  const [picker, setPicker] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const info = models.find((m) => m.name === selected)
  const isLoaded = running.some((r) => r.name === selected)
  const hasImages = draft.attachments.some((a) => a.kind === 'image')
  const canSend = !!(draft.text.trim() || draft.attachments.length) && !streaming

  // Suggestion (facultative) d'un modèle plus doué pour ce type de demande
  const suggestOn = useStore((s) => s.suggestModels)
  const overrides = useStore((s) => s.modelStrengths)
  const setModel = useStore((s) => s.setModel)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const suggestion = useMemo(() => {
    if (!suggestOn || streaming) return null
    const task = detectTask(draft.text, hasImages)
    if (!task) return null
    const model = suggestModel(task, selected, models, running, overrides)
    return model ? { task, model, key: `${task}:${model.name}:${selected}` } : null
  }, [suggestOn, streaming, draft.text, hasImages, selected, models, running, overrides])
  const showSuggestion = suggestion && suggestion.key !== dismissed ? suggestion : null

  // Ce que demande le texte en cours : les boutons Agent / Web / Réflexion s'allument d'eux-mêmes (activés à l'envoi)
  const autoTools = useStore((s) => s.autoTools)
  const tools = supportsTools(info)
  const intent = useMemo(
    () => ({
      lab: wantsLab(draft.text),
      action: wantsAction(draft.text) && !wantsLab(draft.text),
      web: wantsWeb(draft.text),
      think: !!draft.text.trim() && shouldThink({ id: '', role: 'user', content: draft.text, attachments: draft.attachments, createdAt: 0 }),
    }),
    [draft.text, draft.attachments],
  )
  const autoAgent = autoTools && tools && !agentMode && intent.action
  const autoWeb = autoTools && tools && !webSearch && intent.web
  const autoLab = autoTools && tools && !labMode && intent.lab
  const autoThink = think === 'auto' && intent.think
  // Option « activer tout seul » coupée : on propose seulement d'activer l'Agent
  const [agentHintOff, setAgentHintOff] = useState(false)
  const showAgentHint = !autoTools && intent.action && !agentMode && tools && !streaming && !agentHintOff

  useLayoutEffect(() => autosize(taRef.current), [draft.text])

  // Recalcule la hauteur si la largeur change (polices chargées, panneau ouvert, fenêtre redimensionnée).
  useEffect(() => {
    const ta = taRef.current
    if (!ta || typeof ResizeObserver === 'undefined') return
    let width = ta.clientWidth
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth !== width) {
        width = ta.clientWidth
        autosize(ta)
      }
    })
    ro.observe(ta)
    void document.fonts?.ready.then(() => autosize(ta))
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (composerTick || autoFocus) taRef.current?.focus()
  }, [composerTick, autoFocus])

  return (
    <div className="composer">
      {draft.attachments.length > 0 && (
        <div className="composer-tray">
          {draft.attachments.map((a) => (
            <div key={a.id} className="att-chip" title={a.name}>
              {a.kind === 'image' ? (
                <img src={a.dataUrl} alt="" className="att-thumb" />
              ) : (
                <span className="att-icon tone-info">
                  <FileCode size={15} strokeWidth={1.6} />
                </span>
              )}
              <span className="att-text">
                <span className="label-sm ellipsis">{a.name}</span>
                <span className="caption muted">
                  {a.kind === 'image' && a.width ? `${a.width}×${a.height} · ` : ''}
                  {formatBytes(a.size)}
                </span>
              </span>
              <button type="button" className="att-x" aria-label={`Retirer ${a.name}`} onClick={() => removeDraftAttachment(a.id)}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {hasImages && info && !supportsVision(info) && (
        <div className="composer-warn">
          <TriangleExclamationPoint size={14} />
          {prettyName(selected)} ne lit pas les images. Choisissez un modèle « Vision ».
        </div>
      )}

      {showAgentHint && (
        <div className="model-suggest" role="status">
          <Bot size={14} strokeWidth={1.7} />
          <span>
            Pour agir sur l'ordinateur (ouvrir une app, des fichiers…), activez le <b>mode Agent</b> : sinon le modèle ne peut que répondre par écrit.
          </span>
          <span className="spacer" />
          <button type="button" className="suggest-use" onClick={() => setAgentMode(true)}>
            Activer
          </button>
          <button type="button" className="att-x" aria-label="Ignorer" onClick={() => setAgentHintOff(true)}>
            <X size={12} />
          </button>
        </div>
      )}

      {!showAgentHint && showSuggestion && (
        <div className="model-suggest" role="status">
          <Lightbulb size={14} strokeWidth={1.7} />
          <span>
            Pour {strengthInfo(showSuggestion.task).task}, <b>{prettyName(showSuggestion.model.name)}</b> est plus doué que {prettyName(selected)}.
          </span>
          <span className="spacer" />
          <button type="button" className="suggest-use" onClick={() => setModel(showSuggestion.model.name)}>
            Utiliser
          </button>
          <button type="button" className="att-x" aria-label="Ignorer la suggestion" onClick={() => setDismissed(showSuggestion.key)}>
            <X size={12} />
          </button>
        </div>
      )}

      <textarea
        ref={taRef}
        rows={1}
        value={draft.text}
        placeholder={placeholder}
        onChange={(e) => setDraft({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (canSend) void send()
          }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files)
          if (files.length) {
            e.preventDefault()
            void addFiles(files)
          }
        }}
      />

      <div className="composer-bar">
        <IconButton icon={Paperclip} label="Joindre des fichiers ou des images" onClick={() => fileRef.current?.click()} />
        <IconButton icon={ScanLine} label="Capturer l'écran" onClick={() => void addScreenCapture()} />
        <button
          type="button"
          className={`toggle-chip agent-chip${agentMode && supportsTools(info) ? ' is-agent' : autoAgent ? ' will-on' : ''}`}
          disabled={!supportsTools(info)}
          onClick={() => setAgentMode(!agentMode)}
          title={
            !supportsTools(info)
              ? 'Ce modèle ne sait pas utiliser d’outils'
              : autoAgent
                ? 'Votre demande agit sur l’ordinateur : le mode Agent s’activera tout seul à l’envoi.'
              : agentMode
                ? 'Mode agent activé : le modèle peut agir sur votre ordinateur (avec votre accord). Cliquer pour désactiver.'
                : 'Activer le mode agent : commandes, fichiers, applications…'
          }
        >
          <Bot size={14} strokeWidth={1.6} />
          Agent
        </button>
        <button
          type="button"
          className={`toggle-chip web-chip${webSearch && supportsTools(info) ? ' is-web' : autoWeb ? ' will-on' : ''}`}
          disabled={!supportsTools(info)}
          onClick={() => useStore.getState().setWebSearch(!webSearch)}
          aria-pressed={webSearch}
          title={
            !supportsTools(info)
              ? 'Ce modèle ne sait pas utiliser d’outils : pas de recherche Internet'
              : autoWeb
                ? 'Votre demande a besoin d’Internet : la recherche web s’activera toute seule à l’envoi.'
              : webSearch
                ? 'Recherche Internet activée : le modèle peut chercher sur le web et donner la météo. Cliquer pour désactiver.'
                : 'Activer la recherche Internet : actualité, météo, informations récentes'
          }
        >
          <Globe size={14} strokeWidth={1.6} />
          Web
        </button>
        <button
          type="button"
          className={`toggle-chip lab-chip${labMode && supportsTools(info) ? ' is-lab' : autoLab ? ' will-on' : ''}`}
          disabled={!supportsTools(info)}
          onClick={() => useStore.getState().setLabMode(!labMode)}
          aria-pressed={labMode}
          title={
            !supportsTools(info)
              ? 'Ce modèle ne sait pas utiliser d’outils : pas de labo'
              : autoLab
                ? 'Votre demande demande de tester du code : le labo s’activera tout seul à l’envoi.'
              : labMode
                ? 'Labo activé : le modèle compile et teste ses programmes dans des machines isolées (Linux, Windows, Android). Cliquer pour désactiver.'
                : 'Activer le labo : Linux, Windows et Android isolés où le modèle teste ses programmes, sans toucher à votre ordinateur'
          }
        >
          <FlaskConical size={14} strokeWidth={1.6} />
          Labo
        </button>
        {agentMode && supportsTools(info) && cwdLabel && (
          <button type="button" className="cwd-chip" onClick={() => setSettingsOpen(true)} title={`Dossier de travail : ${cwdShown}`}>
            <Folder size={12} strokeWidth={1.7} />
            {cwdLabel}
          </button>
        )}
        {supportsThinking(info) && (
          <button
            type="button"
            className={`toggle-chip is-${think}${autoThink ? ' will-on' : ''}`}
            onClick={() => updateSettings(selected, { think: NEXT_THINK[think] })}
            title={autoThink ? 'Votre demande demande de la réflexion : le modèle réfléchira avant de répondre.' : THINK_HINT[think]}
          >
            <Brain size={14} strokeWidth={1.6} />
            {THINK_LABEL[think]}
          </button>
        )}
        <span className="vdivider" />
        <div className="picker-anchor">
          <button
            type="button"
            className={`model-chip${picker ? ' is-open' : ''}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setPicker((v) => !v)}
          >
            <StatusDot tone={isLoaded ? 'success' : 'neutral'} />
            <span className="ellipsis">{selected ? prettyName(selected) : 'Aucun modèle'}</span>
            <ChevronDown size={12} />
          </button>
          {picker && <ModelPicker placement="up" onClose={() => setPicker(false)} />}
        </div>
        <span className="spacer" />
        {!streaming && (
          <IconButton icon={AudioLines} label="Conversation vocale : parlez à Lumen, il vous répond à voix haute" onClick={() => void startConversation()} />
        )}
        {streaming && activeId ? (
          <button type="button" className="stop-btn" onClick={() => stop(activeId)} title="Arrêter la génération en cours">
            <Square size={10} fill="currentColor" strokeWidth={0} />
            Arrêter
          </button>
        ) : (
          <button type="button" className="send-btn" disabled={!canSend} onClick={() => void send()} aria-label="Envoyer" title="Envoyer (Entrée)">
            <ArrowUp size={18} strokeWidth={2} />
          </button>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void addFiles(files)
        }}
      />
    </div>
  )
}
