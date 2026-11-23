// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { memo, useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, Brain, Check, ChevronDown, Copy, Download, ExternalLink, FastForward, FileCode, LoaderCircle, RefreshCw, Square, TriangleExclamationPoint, Volume2 } from 'lucide-react'
import { useStore, type Message } from '../store'
import { answerWithoutThinking, regenerate } from '../chat'
import { formatBytes, formatSeconds, formatTime, fr, compact } from '../lib/format'
import { prettyName } from '../lib/models'
import { langLabel } from '../lib/highlight'
import { basename, downloadText } from '../lib/files'
import type { CodeFile } from '../lib/codeblocks'
import { Markdown } from './Markdown'
import { ToolCallView } from './ToolCall'
import { Button, IconButton, Logo, Tag, useCopy } from './ui'
import { useVoice } from '../voice/state'
import { readAloud } from '../voice/conversation'

type Props = { msg: Message; convId: string; files?: CodeFile[]; isLast: boolean }

const filesKey = (f?: CodeFile[]) => f?.map((x) => x.key + x.filename + x.complete).join('|') ?? ''

export const MessageView = memo(
  function MessageView(props: Props) {
    return props.msg.role === 'user' ? <UserMessage {...props} /> : <AssistantMessage {...props} />
  },
  (a, b) => a.msg === b.msg && a.isLast === b.isLast && filesKey(a.files) === filesKey(b.files),
)

function UserMessage({ msg }: Props) {
  const openPanel = useStore((s) => s.openPanel)
  const [copied, copy] = useCopy()
  const images = msg.attachments?.filter((a) => a.kind === 'image') ?? []
  const files = msg.attachments?.filter((a) => a.kind === 'file') ?? []
  return (
    <div className="msg msg-user">
      {(images.length > 0 || files.length > 0) && (
        <div className="msg-atts">
          {images.map((a) => (
            <button type="button" key={a.id} className="msg-thumb" onClick={() => openPanel({ type: 'image', id: a.id })} title={a.name}>
              <img src={a.dataUrl} alt={a.name} />
            </button>
          ))}
          {files.map((a) => (
            <button type="button" key={a.id} className="filechip" onClick={() => openPanel({ type: 'code', key: `${msg.id}:att:${a.id}` })}>
              <span className="ftile tone-info">
                <FileCode size={16} strokeWidth={1.5} />
              </span>
              <span className="filechip-text">
                <span className="label-sm">{a.name}</span>
                <span className="caption muted">{formatBytes(a.size)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {msg.content && <div className="bubble">{msg.content}</div>}
      {msg.content && (
        <div className="msg-tools">
          <IconButton icon={copied ? Check : Copy} label="Copier le message" size={14} onClick={() => void copy(msg.content)} />
        </div>
      )}
    </div>
  )
}

function AssistantMessage({ msg, convId, files, isLast }: Props) {
  const running = useStore((s) => s.runtime.running)
  const panel = useStore((s) => s.panel)
  const openPanel = useStore((s) => s.openPanel)
  const [copied, copy] = useCopy()
  const reading = useVoice((s) => s.readingId === msg.id)
  const readingLoading = useVoice((s) => s.readingId === msg.id && s.readingLoading)
  const voiceOn = useVoice((s) => s.phase !== 'off')
  const named = (files ?? []).filter((f) => f.named && f.complete && f.source === 'assistant')
  // Conversation vocale : le texte suit la voix (sous-titres) ; sinon il suit le modèle
  const voiced = useVoiceReveal(msg.id, msg.content)
  const waiting = (msg.streaming && !msg.content && !msg.thinking) || voiced === ''
  const now = useNow(!!waiting)
  const elapsed = Math.max(0, Math.floor((now - msg.createdAt) / 1000))
  // Le texte s'écrit à un rythme régulier au lieu d'apparaître par paquets de tokens.
  const shown = useSmoothText(voiced ?? msg.content, !!msg.streaming || voiced !== null)
  const typing = !!msg.streaming || voiced !== null || shown.length < msg.content.length
  const model = msg.model ?? ''
  const loaded = running.some((r) => r.name === model)

  return (
    <div className={`msg msg-assistant${msg.agentStep ? ' is-step' : ''}`}>
      {msg.context && <ContextDivider ctx={msg.context} model={model} convId={convId} />}
      {!msg.agentStep && (
        <div className="msg-head">
          <Logo size={26} />
          <span className="label">{prettyName(model)}</span>
          <span className="caption muted">{formatTime(msg.createdAt)}</span>
        </div>
      )}

      {msg.thinking && (
        <Thinking
          text={msg.thinking}
          seconds={msg.thinkingSeconds}
          startedAt={msg.createdAt}
          live={!!msg.streaming && !msg.content}
          onSkip={isLast ? () => void answerWithoutThinking(convId) : undefined}
        />
      )}

      {waiting && (
        <div className="loading">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          <span className="caption muted">
            {msg.phase === 'summarizing'
              ? `${prettyName(model)} lit et résume la conversation…`
              : loaded
                ? 'Génération…'
                : `Chargement de ${prettyName(model)} en mémoire…`}
          </span>
          <span className="mono-sm muted loading-time" title="Temps écoulé depuis le début de la réponse">
            {formatSeconds(elapsed)}
          </span>
        </div>
      )}

      {shown && <Markdown content={shown} files={files} streaming={typing} />}

      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="tools">
          {msg.toolCalls.map((t) => (
            <ToolCallView key={t.id} call={t} msgId={msg.id} />
          ))}
        </div>
      )}

      {msg.stopped && (
        <div className="msg-stopped">
          <span className="caption muted">Génération interrompue.</span>
          {isLast && (
            <Button small variant="ghost" icon={RefreshCw} onClick={() => void regenerate(convId)}>
              Relancer
            </Button>
          )}
        </div>
      )}
      {msg.error && (
        <div className="msg-error">
          <TriangleExclamationPoint size={15} />
          <span>{msg.error}</span>
          {isLast && (
            <Button small variant="secondary" icon={RefreshCw} onClick={() => void regenerate(convId)}>
              Réessayer
            </Button>
          )}
        </div>
      )}

      {named.length > 0 && (
        <div className="file-cards">
          {named.map((f) => {
            const active = panel?.type === 'code' && panel.key === f.key
            return (
              <div key={f.key} className={`file-card${active ? ' is-active' : ''}`}>
                <span className="ftile tone-accent">
                  <FileCode size={20} strokeWidth={1.5} />
                </span>
                <div className="file-card-text">
                  <span className="label">{basename(f.filename)}</span>
                  <span className="caption muted">
                    {langLabel(f.lang)} · {f.code.split('\n').length} lignes{active ? ' · ouvert dans le panneau' : ''}
                  </span>
                </div>
                <span className="spacer" />
                <Button icon={ExternalLink} onClick={() => openPanel({ type: 'code', key: f.key })}>
                  Ouvrir
                </Button>
                <IconButton icon={Download} variant="subtle" label="Télécharger" onClick={() => downloadText(f.code, basename(f.filename))} />
              </div>
            )
          })}
        </div>
      )}

      {!typing && !msg.toolCalls?.length && (msg.content || msg.error) && (
        <div className="msg-actions">
          <IconButton icon={copied ? Check : Copy} label="Copier la réponse (Markdown)" onClick={() => void copy(msg.content)} />
          {msg.content.trim() && !voiceOn && (
            <IconButton
              icon={reading ? (readingLoading ? LoaderCircle : Square) : Volume2}
              label={reading ? 'Arrêter la lecture' : 'Écouter la réponse'}
              active={reading}
              className={reading && readingLoading ? 'spin' : ''}
              onClick={() => void readAloud(msg.id, msg.content)}
            />
          )}
          {isLast && <IconButton icon={RefreshCw} label="Régénérer avec le modèle sélectionné" onClick={() => void regenerate(convId)} />}
          <IconButton icon={Download} label="Télécharger la réponse (.md)" onClick={() => downloadText(msg.content, `reponse-${msg.id.slice(0, 6)}.md`, 'text/markdown')} />
          <span className="spacer" />
          {msg.stats && (
            <span className="mono-sm muted">
              {fr(msg.stats.tps, 0)} tok/s · {compact(msg.stats.evalCount)} tokens · {formatSeconds(msg.stats.seconds)}
            </span>
          )}
          {msg.stats?.loadSeconds && msg.stats.loadSeconds > 1 ? <Tag>chargé en {formatSeconds(msg.stats.loadSeconds)}</Tag> : null}
        </div>
      )}
    </div>
  )
}

/**
 * Pendant une conversation vocale, la partie déjà prononcée du message (coupée à la fin du mot en cours),
 * mise à jour ~12 fois par seconde ; null en dehors (le texte suit alors le modèle normalement).
 */
function useVoiceReveal(msgId: string, content: string): string | null {
  const r = useVoice((s) => s.reveal[msgId])
  const upTo = () => {
    if (!r) return content.length
    const k = r.dur ? Math.min(1, (performance.now() - r.at) / (r.dur * 1000)) : 0
    let n = Math.round(r.from + (r.to - r.from) * k)
    if (n > 0 && n < content.length) {
      const space = content.slice(n).search(/\s/) // jusqu'à la fin du mot en cours
      n = space < 0 ? content.length : n + space
    }
    return Math.min(n, r.to || n, content.length)
  }
  const [n, setN] = useState(upTo)
  useEffect(() => {
    setN(upTo())
    if (!r?.dur) return
    const id = setInterval(() => {
      setN(upTo())
      if (performance.now() - r.at > r.dur * 1000) clearInterval(id)
    }, 80)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, content])
  return r ? content.slice(0, n) : null
}

/**
 * Révèle `target` progressivement (requestAnimationFrame), à la vitesse réelle du modèle (moyenne glissante
 * des caractères reçus par seconde) : le texte coule en continu au lieu d'apparaître par rafales puis de s'arrêter.
 * Si un retard s'accumule, il est rattrapé en douceur (~0,6 s). Les messages terminés s'affichent immédiatement.
 */
function useSmoothText(target: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => (streaming ? 0 : target.length))
  const shownRef = useRef(shown)
  const pos = useRef(shown) // position fractionnaire : permet moins d'un caractère par image
  const rate = useRef(0) // caractères/s reçus du modèle (moyenne glissante)
  const seen = useRef({ len: shown, at: performance.now() })
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => {
    if (!streaming && shownRef.current >= targetRef.current.length) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(64, now - last) / 1000
      last = now
      const total = targetRef.current.length
      if (total > seen.current.len) {
        const gap = Math.max(0.016, (now - seen.current.at) / 1000)
        const inst = Math.min(1500, (total - seen.current.len) / gap)
        rate.current = rate.current ? rate.current * 0.85 + inst * 0.15 : inst
        seen.current = { len: total, at: now }
      }
      const backlog = total - pos.current
      if (backlog > 0) {
        const base = Math.min(600, Math.max(18, rate.current || 60))
        const speed = streaming ? Math.max(base, backlog / 0.6) : Math.max(base * 2, backlog / 0.25)
        pos.current = Math.min(total, pos.current + speed * dt)
        const n = Math.floor(pos.current)
        if (n !== shownRef.current) {
          shownRef.current = n
          setShown(n)
        }
      } else if (!streaming) return
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [streaming])

  return shown >= target.length ? target : target.slice(0, shown)
}

/** Séparateur « changement de modèle » : ce que le nouveau modèle a reçu comme contexte. */
function ContextDivider({ ctx, model, convId }: { ctx: NonNullable<Message['context']>; model: string; convId: string }) {
  const summary = useStore((s) => s.conversations[convId]?.summary)
  const [open, setOpen] = useState(false)
  const n = ctx.count
  const detail =
    ctx.mode === 'summary'
      ? 'a reçu un résumé de la conversation'
      : `a relu ${n > 1 ? `les ${n} messages précédents` : 'le message précédent'}`
  return (
    <div className="ctx-divider">
      <div className="ctx-line">
        <span className="ctx-pill">
          <ArrowLeftRight size={12} strokeWidth={1.8} />
          {ctx.from ? (
            <>
              {prettyName(ctx.from)} <span className="muted">→</span> <b>{prettyName(model)}</b>
            </>
          ) : (
            <>Conversation résumée pour tenir dans la mémoire du modèle</>
          )}
          {ctx.from && <span className="muted">· {detail}</span>}
          {ctx.mode === 'summary' && summary && (
            <button type="button" className="ctx-toggle" onClick={() => setOpen((v) => !v)}>
              {open ? 'Masquer le résumé' : 'Voir le résumé'}
            </button>
          )}
        </span>
      </div>
      {open && summary && <div className="ctx-summary">{summary.text}</div>}
    </div>
  )
}

/** Horloge qui avance chaque seconde tant que `active` est vrai. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

const lastLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/[*#`_>-]+/g, ' ').trim())
    .filter(Boolean)
    .pop() ?? ''

function Thinking({ text, seconds, startedAt, live, onSkip }: { text: string; seconds?: number; startedAt: number; live: boolean; onSkip?: () => void }) {
  // Repliée par défaut, même pendant la réflexion : une ligne d'aperçu suffit.
  const [open, setOpen] = useState(false)
  const now = useNow(live)
  const elapsed = live ? Math.max(0, (now - startedAt) / 1000) : seconds
  return (
    <div className={`thinking${open ? ' is-open' : ''}${live ? ' is-live' : ''}`}>
      <div className="thinking-row">
        <button type="button" className="thinking-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Brain size={14} strokeWidth={1.6} />
          <span className="thinking-label">{live ? 'Réflexion en cours…' : 'Réflexion'}</span>
          {elapsed ? <span className="mono-sm muted">{formatSeconds(Math.round(elapsed))}</span> : null}
          <ChevronDown size={13} className="chev" />
        </button>
        {live && onSkip && (
          <button type="button" className="thinking-skip" onClick={onSkip} title="Arrêter la réflexion et répondre tout de suite">
            <FastForward size={12} strokeWidth={1.8} />
            Répondre directement
          </button>
        )}
      </div>
      {live && !open && <div className="thinking-preview">{lastLine(text)}</div>}
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}
