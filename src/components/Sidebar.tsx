// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Command, Cpu, Folder, LoaderCircle, PanelLeft, Pencil, Plus, Search, Settings, Shield, ShieldCheck, Trash, X } from 'lucide-react'
import { useStore, type Conversation } from '../store'
import { dayGroup, formatBytes, fr } from '../lib/format'
import { prettyName } from '../lib/models'
import { conversationFiles } from '../lib/codeblocks'
import { IconButton, Kbd, Logo, Meter, StackMeter, StatusDot, Tag, useArmed } from './ui'
import { GiB, useLiveUsage } from '../lib/hardware'
import { flag, useVpn } from '../lib/vpn'

const GROUP_ORDER = ["Aujourd'hui", 'Hier', '7 derniers jours', '30 derniers jours', 'Plus ancien']

/** Entrée « VPN » : bouclier vert et pays vu par les sites quand le VPN tourne (lancé ici, par l'agent ou ailleurs). */
function VpnItem({ active, onClick }: { active: boolean; onClick: () => void }) {
  const vpn = useVpn()
  const code = vpn?.connected ? (vpn.place?.country || vpn.country || '') : ''
  return (
    <button type="button" className={`sb-item${active ? ' is-active' : ''}`} onClick={onClick} title={vpn?.connected ? `VPN actif : ${vpn.place?.countryName ?? vpn.countryName ?? ''}` : 'VPN arrêté'}>
      {vpn?.connected ? <ShieldCheck size={16} strokeWidth={1.6} className="vpn-on" /> : <Shield size={16} strokeWidth={1.6} />}
      <span>VPN</span>
      <span className="spacer" />
      {vpn?.busy ? (
        <LoaderCircle size={13} strokeWidth={1.8} className="muted" />
      ) : vpn?.connected ? (
        <span className="sb-vpn-on">
          {flag(code)} {code.toUpperCase() || 'ON'}
        </span>
      ) : null}
    </button>
  )
}

export function Sidebar() {
  const webSearch = useStore((s) => s.webSearch)
  const conversations = useStore((s) => s.conversations)
  const order = useStore((s) => s.order)
  const activeId = useStore((s) => s.activeId)
  const view = useStore((s) => s.view)
  const streaming = useStore((s) => s.streaming)
  const searchTick = useStore((s) => s.searchTick)
  const models = useStore((s) => s.runtime.models)
  const { newChat, setView, toggleSidebar, setSettingsOpen } = useStore.getState()

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!searchTick) return
    setSearching(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [searchTick])

  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const list = order
      .map((id) => conversations[id])
      .filter((c): c is Conversation => !!c && c.messages.length > 0)
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
    const map = new Map<string, Conversation[]>()
    for (const c of list) {
      const g = dayGroup(c.updatedAt)
      map.set(g, [...(map.get(g) ?? []), c])
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const)
  }, [order, conversations, q])

  const fileCount = useMemo(
    () =>
      Object.values(conversations).reduce(
        (n, c) =>
          n +
          conversationFiles(c.messages).filter((f) => f.named || f.source === 'upload').length +
          c.messages.reduce((k, m) => k + (m.attachments?.filter((a) => a.kind === 'image').length ?? 0), 0),
        0,
      ),
    [conversations],
  )

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <Logo />
        <span className="brand">Lumen</span>
        <Tag tone="accent">Local</Tag>
        <span className="spacer" />
        <IconButton icon={PanelLeft} label="Masquer la barre latérale" onClick={toggleSidebar} />
      </div>

      <button type="button" className="sb-new" onClick={newChat}>
        <Plus size={16} strokeWidth={1.7} />
        <span>Nouvelle conversation</span>
        <span className="spacer" />
        <Kbd>
          <Command size={11} strokeWidth={1.7} />⇧O
        </Kbd>
      </button>

      <nav className="sb-nav">
        {searching ? (
          <div className="sb-search">
            <Search size={16} strokeWidth={1.6} />
            <input
              ref={inputRef}
              value={query}
              placeholder="Rechercher…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('')
                  setSearching(false)
                }
              }}
            />
            <button type="button" className="sb-search-x" aria-label="Fermer la recherche" onClick={() => { setQuery(''); setSearching(false) }}>
              <X size={14} />
            </button>
          </div>
        ) : (
          <button type="button" className="sb-item" onClick={() => setSearching(true)}>
            <Search size={16} strokeWidth={1.6} />
            <span>Rechercher</span>
            <span className="spacer" />
            <Kbd>
              <Command size={11} strokeWidth={1.7} />K
            </Kbd>
          </button>
        )}
        <button type="button" className={`sb-item${view === 'library' ? ' is-active' : ''}`} onClick={() => setView('library')}>
          <Folder size={16} strokeWidth={1.6} />
          <span>Fichiers & captures</span>
          <span className="spacer" />
          <span className="mono-sm muted">{fileCount}</span>
        </button>
        <button type="button" className={`sb-item${view === 'models' ? ' is-active' : ''}`} onClick={() => setView('models')}>
          <Box size={16} strokeWidth={1.6} />
          <span>Modèles locaux</span>
          <span className="spacer" />
          <span className="mono-sm muted">{models.length || ''}</span>
        </button>
        <VpnItem active={view === 'vpn'} onClick={() => setView('vpn')} />
      </nav>

      <div className="sb-list">
        {groups.length === 0 && (
          <p className="sb-empty">{q ? 'Aucun résultat.' : 'Vos conversations apparaîtront ici.'}</p>
        )}
        {groups.map(([label, list]) => (
          <div key={label} className="sb-group">
            <div className="overline">{label}</div>
            {list.map((c) => (
              <ConversationItem key={c.id} c={c} active={view === 'chat' && c.id === activeId} streaming={!!streaming[c.id]} />
            ))}
          </div>
        ))}
      </div>

      <RuntimeCard />

      <div className="sb-user">
        <span className="avatar" />
        <div className="sb-user-text">
          <span className="label">Mon poste</span>
          <span className="caption muted">{webSearch ? 'Données locales · recherche web' : '100 % hors ligne · données locales'}</span>
        </div>
        <span className="spacer" />
        <IconButton icon={Settings} label="Réglages" onClick={() => setSettingsOpen(true)} />
      </div>
    </aside>
  )
}

function ConversationItem({ c, active, streaming }: { c: Conversation; active: boolean; streaming: boolean }) {
  const [editing, setEditing] = useState(false)
  const [armed, trigger] = useArmed()
  const { openConversation, updateConversation, deleteConversation } = useStore.getState()

  const commit = (value: string) => {
    const v = value.trim()
    if (v) updateConversation(c.id, { title: v })
    setEditing(false)
  }

  return (
    <div
      className={`conv${active ? ' is-active' : ''}`}
      onClick={() => !editing && openConversation(c.id)}
      onDoubleClick={() => setEditing(true)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && !editing && openConversation(c.id)}
    >
      {streaming && <StatusDot tone="accent" pulse />}
      {editing ? (
        <input
          className="conv-input"
          autoFocus
          defaultValue={c.title}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span className="conv-title">{c.title}</span>
      )}
      {!editing && (
        <span className="conv-actions">
          <button type="button" title="Renommer" onClick={(e) => { e.stopPropagation(); setEditing(true) }}>
            <Pencil size={13} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className={armed ? 'is-danger' : ''}
            title={armed ? 'Cliquer à nouveau pour supprimer' : 'Supprimer'}
            onClick={(e) => {
              e.stopPropagation()
              if (trigger()) deleteConversation(c.id)
            }}
          >
            <Trash size={13} strokeWidth={1.6} />
          </button>
        </span>
      )}
    </div>
  )
}

function RuntimeCard() {
  const runtime = useStore((s) => s.runtime)
  const tps = useStore((s) => s.tpsHistory[s.tpsHistory.length - 1])
  const setView = useStore((s) => s.setView)
  const loaded = runtime.running[0]
  const gpu = loaded?.size ? loaded.size_vram / loaded.size : 0
  const live = useLiveUsage(3000)
  const models = GiB(runtime.running.reduce((n, r) => n + r.size, 0))
  const other = live ? Math.max(0, live.ramUsedGB - models) : 0
  const state = runtime.connected === null ? 'Connexion…' : runtime.connected ? 'Runtime local actif' : 'Ollama injoignable'

  return (
    <button type="button" className="runtime" onClick={() => setView('models')} title="Gérer les modèles locaux">
      <div className="row">
        <StatusDot tone={runtime.connected ? 'success' : runtime.connected === null ? 'neutral' : 'danger'} />
        <span className="label-sm">{state}</span>
        <span className="spacer" />
        <span className="mono-sm muted" title="Version d'Ollama">{runtime.version ? `v${runtime.version}` : 'Ollama'}</span>
      </div>
      {loaded ? (
        <>
          <div className="row">
            <Cpu size={14} strokeWidth={1.5} className="muted" />
            <span className="caption ellipsis">{prettyName(loaded.name)}</span>
            <span className="spacer" />
            <span className="mono-sm">{formatBytes(loaded.size_vram)}</span>
          </div>
          {live ? (
            <StackMeter
              label="Mémoire utilisée en direct"
              parts={[
                { value: models / live.ramTotalGB, className: 'seg-models', title: `Modèles : ${fr(models, 1)} Go` },
                { value: other / live.ramTotalGB, className: 'seg-other', title: `Reste du système : ${fr(other, 1)} Go` },
              ]}
            />
          ) : (
            <Meter value={gpu} />
          )}
          <div className="caption muted">
            {live ? `${fr(live.ramUsedGB, 1)} / ${fr(live.ramTotalGB, 0)} Go` : `${Math.round(gpu * 100)} % en VRAM`}
            {live?.gpuPct != null ? ` · GPU ${live.gpuPct} %` : ''}
            {tps ? ` · ${fr(tps, 0)} tok/s` : ''}
            {runtime.running.length > 1 ? ` · +${runtime.running.length - 1} modèle(s)` : ''}
          </div>
        </>
      ) : (
        <div className="caption muted">{runtime.connected ? 'Aucun modèle en mémoire' : 'Lancez « ollama serve » dans un terminal'}</div>
      )}
    </button>
  )
}
