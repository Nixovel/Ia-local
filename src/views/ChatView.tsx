// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Brain, ChevronDown, ChevronRight, Code, FileCode, FileText, Gauge, Globe, Mail, Monitor, Palette, PanelLeft, PanelRight, ScanLine, Settings,
  Share, ShieldCheck, Terminal, TriangleExclamationPoint, Upload, WifiOff, Zap,
} from 'lucide-react'
import { useStore, type Attachment, type Conversation } from '../store'
import { addFiles, addScreenCapture } from '../chat'
import { canPreview, conversationFiles, type CodeFile } from '../lib/codeblocks'
import { compact, fr, momentOfDay } from '../lib/format'
import { formatCtx, prettyName, type Tone } from '../lib/models'
import { basename, downloadText } from '../lib/files'
import { langLabel } from '../lib/highlight'
import { Composer } from '../components/Composer'
import { ModelPicker } from '../components/ModelPicker'
import { MessageView } from '../components/Message'
import { FilePanel } from '../components/FilePanel'
import { isSvgCode } from '../components/SvgImage'
import { VoiceDock } from '../components/VoiceDock'
import { AUTHOR, REPO_URL } from '../lib/authorship'
import { useVoice } from '../voice/state'
import { ImageViewer } from '../components/ImageViewer'
import { LabScreen } from '../components/LabScreen'
import { useLabScreen } from '../lib/labScreen'
import { Button, IconButton, Logo, StatusDot } from '../components/ui'

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

export function ChatView() {
  const voiceOn = useVoice((s) => s.phase !== 'off')
  const conv = useStore((s) => (s.activeId ? s.conversations[s.activeId] : undefined))
  const panel = useStore((s) => s.panel)
  const labScreenOpen = useLabScreen((s) => s.open)
  const selected = useStore((s) => s.selectedModel)
  const messages = conv?.messages
  const files = useMemo(() => (messages ? conversationFiles(messages) : []), [messages])
  const images = useMemo(
    () => (messages ? messages.flatMap((m) => (m.attachments ?? []).filter((a) => a.kind === 'image')) : []),
    [messages],
  )
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const empty = !conv || conv.messages.length === 0

  // Quand une réponse (ou tout un tour d'agent) se termine avec une page web, on ouvre directement son aperçu.
  const [autoPreviewKey, setAutoPreviewKey] = useState<string | null>(null)
  const convStreaming = useStore((s) => (s.activeId ? !!s.streaming[s.activeId] : false))
  const wasStreaming = useRef(false)
  useEffect(() => {
    const was = wasStreaming.current
    wasStreaming.current = convStreaming
    if (!was || convStreaming || !messages) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || last.stopped) return
    let i = messages.length - 1
    while (i >= 0 && messages[i].role === 'assistant') i--
    const turn = new Set(messages.slice(i + 1).map((m) => m.id))
    const web = files.filter(
      (f) =>
        turn.has(f.msgId) &&
        f.source !== 'upload' &&
        f.complete &&
        canPreview(f.lang, f.filename) &&
        !/^(markdown|md)$/i.test(f.lang) &&
        !/\.(md|markdown)$/i.test(f.filename) &&
        // un dessin SVG est déjà affiché comme une image dans le fil
        !isSvgCode(f.code, f.lang, f.filename),
    )
    const target =
      web.find((f) => /(^|\/)index\.html?$/i.test(f.filename)) ?? web.find((f) => /\.html?$/i.test(f.filename) || f.lang === 'html') ?? web[0]
    if (target) {
      setAutoPreviewKey(target.key)
      useStore.getState().openPanel({ type: 'code', key: target.key })
    }
  }, [convStreaming, messages, files])

  return (
    <div
      className="chat-layout"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current++
        setDragging(true)
      }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setDragging(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setDragging(false)
        void addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <section className="chat-col">
        {empty ? (
          <Home />
        ) : (
          <>
            <Topbar conv={conv} files={files} images={images} />
            <Thread conv={conv} files={files} />
            <div className="composer-wrap">
              {voiceOn ? <VoiceDock /> : <Composer placeholder={`Répondre à ${prettyName(selected) || 'votre modèle'}…`} />}
              <PrivacyNote />
            </div>
          </>
        )}
      </section>

      {panel?.type === 'code' && files.length > 0 && (
        <FilePanel files={files} selectedKey={panel.key} autoPreview={panel.key === autoPreviewKey} />
      )}
      {panel?.type === 'image' && images.length > 0 && <ImageViewer images={images} currentId={panel.id} />}
      {labScreenOpen && !panel && <LabScreen />}

      {dragging && (
        <div className="dropzone">
          <div className="dropzone-inner">
            <Upload size={22} />
            Déposez vos fichiers, images ou captures
          </div>
        </div>
      )}
    </div>
  )
}

function PrivacyNote() {
  const web = useStore((s) => s.webSearch)
  return (
    <div className="footnote">
      {web ? <Globe size={12} strokeWidth={1.6} /> : <ShieldCheck size={12} strokeWidth={1.6} />}
      {web
        ? 'Modèles 100 % locaux — seules les recherches web et la météo demandées par le modèle passent par Internet.'
        : 'Exécution 100 % locale — aucune donnée ne quitte cette machine.'}
    </div>
  )
}

function OfflineBanner() {
  const runtime = useStore((s) => s.runtime)
  if (runtime.connected !== false) return null
  return (
    <div className="banner-offline">
      <TriangleExclamationPoint size={16} />
      <span>
        Ollama ne répond pas. Lancez <code className="inline-code">ollama serve</code> puis réessayez.
      </span>
      <span className="spacer" />
      <Button small variant="secondary" onClick={() => void useStore.getState().refreshRuntime(true)}>
        Réessayer
      </Button>
    </div>
  )
}

function Topbar({ conv, files, images }: { conv: Conversation; files: CodeFile[]; images: Attachment[] }) {
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const panel = useStore((s) => s.panel)
  const labMode = useStore((s) => s.labMode)
  const screenOpen = useLabScreen((s) => s.open) && !panel
  const numCtx = useStore((s) => s.settingsFor(conv.model).num_ctx)
  const { toggleSidebar, openPanel, updateConversation } = useStore.getState()
  const [editing, setEditing] = useState(false)
  const last = [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.stats)?.stats

  const exportMd = () => {
    const md = [`# ${conv.title}`, '']
    for (const m of conv.messages) {
      md.push(m.role === 'user' ? '### Vous' : `### ${prettyName(m.model ?? conv.model)}`, '')
      for (const a of m.attachments ?? []) md.push(`> Pièce jointe : ${a.name}`)
      md.push(m.content, '')
    }
    const slug = conv.title.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'conversation'
    downloadText(md.join('\n'), `${slug}.md`, 'text/markdown')
  }

  const togglePanel = () => {
    if (panel) openPanel(null)
    else if (files.length) openPanel({ type: 'code', key: files[files.length - 1].key })
    else if (images.length) openPanel({ type: 'image', id: images[images.length - 1].id })
  }

  return (
    <header className="topbar">
      {!sidebarOpen && <IconButton icon={PanelLeft} label="Afficher la barre latérale" onClick={toggleSidebar} />}
      {editing ? (
        <input
          className="input topbar-input"
          autoFocus
          defaultValue={conv.title}
          onBlur={(e) => {
            if (e.target.value.trim()) updateConversation(conv.id, { title: e.target.value.trim() })
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <button type="button" className="topbar-title" onClick={() => setEditing(true)} title="Renommer">
          <span className="ellipsis">{conv.title}</span>
          <ChevronDown size={14} className="muted" />
        </button>
      )}
      <span className="spacer" />
      {last && last.tps > 0 && (
        <span className="pill" title="Vitesse de la dernière réponse">
          <Zap size={12} className="accent" />
          {fr(last.tps, 0)} tok/s
        </span>
      )}
      {last && (
        <span className="pill" title="Contexte utilisé par le dernier échange">
          <Gauge size={12} className="muted" />
          {compact(last.promptCount + last.evalCount)} / {formatCtx(numCtx)} ctx
        </span>
      )}
      <IconButton icon={Share} label="Exporter la conversation (.md)" onClick={exportMd} />
      {(labMode || screenOpen) && (
        <IconButton
          icon={Monitor}
          label="Écran du labo en direct (Windows, Linux, Android) : voir et piloter ce que fait le modèle"
          active={screenOpen}
          onClick={() => (screenOpen ? useLabScreen.getState().close() : useLabScreen.getState().show())}
        />
      )}
      <IconButton
        icon={PanelRight}
        label={files.length || images.length ? 'Fichiers et images de la conversation' : 'Aucun fichier pour le moment'}
        active={!!panel}
        disabled={!files.length && !images.length}
        onClick={togglePanel}
      />
    </header>
  )
}

function Thread({ conv, files }: { conv: Conversation; files: CodeFile[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const byMsg = useMemo(() => {
    const map = new Map<string, CodeFile[]>()
    for (const f of files) map.set(f.msgId, [...(map.get(f.msgId) ?? []), f])
    return map
  }, [files])

  useEffect(() => {
    stick.current = true
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conv.id])

  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [conv.messages])

  // Le texte s'écrit image par image : on suit la hauteur réelle du fil, pas seulement les nouveaux tokens.
  const innerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    const inner = innerRef.current
    if (!el || !inner || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      className="thread"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      }}
    >
      <div className="thread-inner" ref={innerRef}>
        <OfflineBanner />
        {conv.messages.map((m, i) => (
          <MessageView key={m.id} msg={m} convId={conv.id} files={byMsg.get(m.id)} isLast={i === conv.messages.length - 1} />
        ))}
      </div>
    </div>
  )
}

const SUGGESTIONS: { icon: typeof Code; tone: Tone; label: string; prompt?: string; action?: 'capture' | 'file' }[] = [
  { icon: Code, tone: 'info', label: 'Écrire du code', prompt: 'Écris un script Python qui ' },
  { icon: Mail, tone: 'success', label: 'Rédiger un mail', prompt: 'Rédige un mail professionnel et courtois pour ' },
  { icon: Palette, tone: 'violet', label: 'Créer une image', prompt: 'Dessine-moi ' },
  { icon: ScanLine, tone: 'violet', label: 'Analyser une capture', action: 'capture', prompt: "Que vois-tu sur cette capture ? Repère les problèmes éventuels." },
  { icon: FileText, tone: 'accent', label: 'Résumer un fichier', action: 'file', prompt: 'Résume ce fichier en 5 points clés.' },
  { icon: Terminal, tone: 'danger', label: 'Déboguer une erreur', prompt: 'Voici une erreur. Explique la cause et propose un correctif :\n\n' },
  { icon: Brain, tone: 'info', label: 'Raisonner pas à pas', prompt: 'Réfléchis étape par étape : ' },
]

function Home() {
  const voiceOn = useVoice((s) => s.phase !== 'off')
  const webSearch = useStore((s) => s.webSearch)
  const selected = useStore((s) => s.selectedModel)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const running = useStore((s) => s.runtime.running)
  const connected = useStore((s) => s.runtime.connected)
  const conversations = useStore((s) => s.conversations)
  const order = useStore((s) => s.order)
  const { setDraft, focusComposer, toggleSidebar, setSettingsOpen, openConversation, openPanel } = useStore.getState()
  const [picker, setPicker] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const loaded = running.find((r) => r.name === selected)

  const recents = useMemo(() => {
    const out: { key: string; convId: string; name: string; meta: string; image?: string; open: () => void }[] = []
    for (const id of order) {
      const c = conversations[id]
      if (!c) continue
      for (const m of [...c.messages].reverse()) {
        for (const a of m.attachments ?? []) {
          if (a.kind === 'image')
            out.push({ key: a.id, convId: id, name: a.name, meta: `Image${a.width ? ` · ${a.width}×${a.height}` : ''}`, image: a.dataUrl, open: () => openPanel({ type: 'image', id: a.id }) })
        }
      }
      for (const f of conversationFiles(c.messages).filter((f) => f.named).reverse())
        out.push({ key: f.key, convId: id, name: basename(f.filename), meta: `${langLabel(f.lang)} · ${c.title}`, open: () => openPanel({ type: 'code', key: f.key }) })
      if (out.length >= 3) break
    }
    return out.slice(0, 3)
  }, [order, conversations, openPanel])

  return (
    <div className="home">
      <div className="home-top">
        {!sidebarOpen && <IconButton icon={PanelLeft} label="Afficher la barre latérale" onClick={toggleSidebar} />}
        <div className="picker-anchor">
          <button
            type="button"
            className={`model-select${picker ? ' is-open' : ''}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setPicker((v) => !v)}
          >
            <StatusDot tone={loaded ? 'success' : 'neutral'} />
            <span className="ellipsis">{selected ? prettyName(selected) : 'Choisir un modèle'}</span>
            <ChevronDown size={14} className="muted" />
          </button>
          {picker && <ModelPicker placement="down" onClose={() => setPicker(false)} />}
        </div>
        <span className="spacer" />
        {webSearch ? (
          <button type="button" className="pill pill-info" onClick={() => useStore.getState().setWebSearch(false)} title="Recherche Internet activée — cliquer pour repasser hors ligne">
            <Globe size={12} />
            Recherche web
          </button>
        ) : (
          <span className="pill pill-success">
            <WifiOff size={12} />
            Mode hors ligne
          </span>
        )}
        <IconButton icon={Settings} label="Réglages" onClick={() => setSettingsOpen(true)} />
      </div>

      <div className="home-center">
        <div className="halo" />
        <div className="home-inner">
          <Logo size={48} glow />
          <h1 className="display">
            Que construit-on <em>{momentOfDay()}</em> ?
          </h1>
          <p className="lead">Vos modèles tournent sur cette machine. Rien ne sort, tout reste rapide.</p>
          {connected === false && (
            <div className="home-banner">
              <OfflineBanner />
            </div>
          )}
          <div className="home-composer">
            {voiceOn ? <VoiceDock /> : <Composer placeholder="Décrivez une tâche, collez du code ou glissez une capture d'écran…" autoFocus />}
          </div>
          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button
                type="button"
                key={s.label}
                className={`chip tone-${s.tone}`}
                onClick={() => {
                  if (s.prompt) setDraft({ text: s.prompt })
                  if (s.action === 'capture') void addScreenCapture()
                  else if (s.action === 'file') fileRef.current?.click()
                  else focusComposer()
                }}
              >
                <s.icon size={14} strokeWidth={1.6} />
                {s.label}
              </button>
            ))}
          </div>

          {recents.length > 0 && (
            <div className="recents">
              <div className="recents-head">
                <span className="overline">Fichiers & captures récents</span>
                <span className="spacer" />
                <button type="button" className="link-btn" onClick={() => useStore.getState().setView('library')}>
                  Tout voir <ChevronRight size={12} />
                </button>
              </div>
              <div className="recents-row">
                {recents.map((r) => (
                  <button
                    type="button"
                    key={r.key}
                    className="recent"
                    onClick={() => {
                      openConversation(r.convId)
                      r.open()
                    }}
                  >
                    {r.image ? (
                      <img src={r.image} alt="" className="recent-thumb" />
                    ) : (
                      <span className="ftile tone-info">
                        <FileCode size={16} strokeWidth={1.5} />
                      </span>
                    )}
                    <span className="recent-text">
                      <span className="label-sm ellipsis">{r.name}</span>
                      <span className="caption muted ellipsis">{r.meta}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="home-foot">
        {webSearch ? <Globe size={12} strokeWidth={1.6} /> : <ShieldCheck size={12} strokeWidth={1.6} />}
        {webSearch ? 'Modèles locaux · recherche web activée' : 'Lumen fonctionne sans Internet'}
        {selected ? ` · ${prettyName(selected)}${loaded ? ' en mémoire' : ''}` : ''}
        <span className="home-credit">
          ·{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
            par {AUTHOR}
          </a>
        </span>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (list.length) void addFiles(list).then(focusComposer)
        }}
      />
    </div>
  )
}
